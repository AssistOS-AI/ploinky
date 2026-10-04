# Live update and cache acceptance runbook

This records how the local acceptance harness is used, what it depends on, which failures it reports and how little it recovers on its own. It authorizes no execution. Every live statement below is "implemented and covered by fabricated controls" unless a run on the selected Ubuntu host says otherwise; the harness's own unit controls use fabricated engines, children and filesystems and never touch a Box, engine, network or credential.

## Entrypoint

```sh
npm test -- --acceptance /absolute/evidence/manifest_codex.json
```

`tests/run-all.sh` and `tests/test_all.sh` forward this test-only form and dispatch it to `tests/e2e/liveUpdateCache/run_codex.mjs` before any branch configuration, worktree, temporary workspace or AgentLib setup. Any other argument is refused (exit 64). The default `npm test` result stays component-only and says that live update/cache and release acceptance are UNRUN.

Exit codes: 0 only with the explicit PASS verdict, 1 for a failed stage, 3 for `AWAITING_RELEASE_FIXTURE`, 64 for a refusal before any adapter exists.

## Stage to adapter map

| Stage | Adapter (all under `tests/e2e/liveUpdateCache/`) | What it observes |
| --- | --- | --- |
| U0 | `live_admission_codex.mjs`, `box_probe_codex.mjs`, `worker_host_codex.mjs` | Engine and Box inspection through fixed templates, the product status API through the pinned worker, an in-Box membership probe, Router `/health`, Git state of every participating repository, then `assertLiveBefore`. |
| U1, U7 marker | `browser_codex.mjs`, `application_marker_codex.mjs`, `marker_files_codex.mjs` | The repository's own Explorer smoke helpers upload and preview the owned marker; the workspace file is read bounded and identity-checked. |
| U2 | `cache_ports_codex.mjs`, `store_probe_codex.mjs` | `start explorer` through the outer CLI; runtime identity and store object comparison for the declared graph. |
| U3, U4 | `git_fixture_codex.mjs`, `store_probe_codex.mjs`, `worker_host_codex.mjs` | Owned Git server, package A then B, `add repo` and `enable agent` through the outer CLI, the actual outer update through the pinned worker. |
| U5 | `cache_ports_codex.mjs` | Two owned aliases, `--debug reinstall` of alias A with the bounded GC-summary projection, alias B as the independently retained reader. |
| U6 | `negative_port_codex.mjs`, `../updateContinueOnError/run.mjs` | The tightened continuation runner as one owned child; its sanitized observation file is validated strictly. |
| U7, U7b | `phases_functional_codex.mjs`, `cleanup_port_codex.mjs` | Settling update, marker preservation, unchanged primary configuration, owned cleanup. |
| U7c | `release_codex.mjs` | A different Box over a recreated workspace with the identical pushed commit map and image, admitted from scratch. |
| U8 | `gates_codex.mjs` | Copilot, OnlyOffice, WebMeet through `scripts/run-playwright.mjs`. |
| U9 | `release_codex.mjs`, `acceptance_codex.mjs` | Closure of every owned handle, then the one exclusive receipt. |

## Operator preparation (nothing below is created by the harness)

1. A manifest in the strict schema of `manifest_codex.mjs`, bound to the real pushed candidate. The harness defines these derivations and the manifest generator must use them: `engineIdentityOf` (engine identity from `podman info` version, graph/run roots, rootless, uid and path), `gpuWiringIdentityOf` (the Box GPU-grant label, or the fixed absent value), `publicationsId` and `mountsId` for the observed publications and read-only source mounts, and `selector.generation` (copied verbatim from the in-Box probe) for `box.activeGeneration`.
2. An evidence root outside the workspace, candidate and participating repositories, mode 0700, containing no earlier receipt.
3. The source catalog `sources_codex.json` for the exact pushed candidate, built in a fresh process:
   `node tests/e2e/liveUpdateCache/catalog_builder_codex.mjs --candidate <root> --commit <40-hex> --out <evidence>/sources_codex.json [--extra <relative module>]`.
   It records Node's own resolve/load for one finite import of `ploinky-box/bin/ploinky-box.mjs` and `ploinky-box/supervisor.mjs`. Any import reached only at run time is absent and is refused by the worker; add it with `--extra` and rebuild.
4. `inputs_codex.json` in the evidence root: `schemaVersion`, `runId`, a digest-pinned `probeAgentImage` that already exists in the Box's nested image store, the absolute `releaseManifest` path of the Copilot gate (outside protected trees) and the exact `expectedUpdates` (errors, blockedBy, recordIds) for `normal-update` and `settling-update`.
5. A fresh pinned release manifest for U7c, created after U7b under its own grant.

## Two-invocation flow

The first invocation runs U0-U7b. Cleanup completes, then the receipts and settled-epoch record are frozen into `functional_codex.json`. With no `release_codex.json` yet, it reports `AWAITING_RELEASE_FIXTURE` (exit 3) and creates no final receipt. After the operator has recreated the canonical fixture under the release grant and written the release manifest, a second invocation of the same command verifies the frozen file (run ID, order, hashes, no gate credit) and resumes at U7c through U9. The operator's wait is not counted against the schedule. The entrypoint only requires the manifest's grant to be open; the run itself admits the whole schedule from U0 on a fresh start and only the remaining U7c-U9 suffix (4,200,000 ms) on a resume, against the grant window and the release manifest's own grant.

## Operational constraint: outer Box age at the canonical gates

Before each gate the harness admits the remaining validity of the outer Box against the 30-minute generation clamp and the four-hour image limit. At the start of Copilot the remaining gate work is Copilot 540,000 ms plus OnlyOffice 840,000 ms plus WebMeet 120,000 ms plus a 30,000 ms settlement allowance per gate, 1,590,000 ms in total. The Box's StartedAt therefore cannot be more than 210,000 ms (3.5 minutes) old when Copilot begins, and the three gates must follow the fresh deployment's admission closely; an older Box refuses with `box-freshness-insufficient` and must be recreated. Re-reading metadata or restarting a nested agent never renews StartedAt. The 216-minute schedule does not widen either limit.

## Runtime prerequisites

Ubuntu host, the operator account of the manifest, rootless Podman, `git`, the pinned Node binary named in the manifest (the worker proves its version, path and SHA-256 and refuses `NODE_OPTIONS`/execArgv), Node 22 or later for the entrypoint, Chromium plus the repository's `tests/smoke` dependencies for U1/U7/U8, the BusyBox image named by `fixtureEndpoint` present by ID with pull disabled, and Node's synchronous `module.registerHooks`.

## Expected refusals

Fixed public codes only. Examples: `runtime-host-unqualified`, `acceptance-inputs-missing`, `receipt-exists`, `functional-receipt-invalid`, `schedule-insufficient`, `phase-budget-expired`, `run-uncertain`, `live-probe-*`, `graph-not-ready`, `generation-not-fresh`, `replacement-not-observed`, `predecessor-mutated`, `ordinary-gc-not-proven`, `reader-changed-during-gc`, `continuation-*`, `release-fixture-not-fresh`, `canonical-gate-invalid`, `box-freshness-insufficient`, `image-freshness-insufficient`, `owned-resource-unsettled`.

## Recovery limits

Private, append-only recovery records `recovery_<NNN>_<label>_codex.json` are written exclusively into the evidence root: the owned server's exact container ID and labels, the fixture directory and marker inodes (never the marker's content), the repository key and URL and the alias names, the registration intent before the commands that could half-succeed, and, on failure, the failed stage, reason, passed stages, unsettled commands and elapsed time. The server is launched with `--cidfile <evidence>/fixture/server.cid`, so its exact ID is recoverable even if the launch command fails. These records, not guesses, name what to remove by hand.

The first refusal stops the run and nothing is cleaned up by guesswork. The failure receipt names the failed stage and lists any unsettled retained command. Owned resources that may remain: the fixture directory `<evidence>/fixture` and its private marker, the BusyBox server container (exact ID recorded in memory only, label `io.assistos.ploinky-test.owner=<runId>`), the repository key and `.ploinky/repos/UcProbe<suffix>`, the aliases `uc-<suffix>-a|b`, the marker `update-persistence-<runId stem>_codex.txt` in the workspace, and the continuation fixtures `UpdateE2E-<runId>` and `.update-e2e-<runId>` with a possible `active-scope-restore_codex.json`. Remove them only with the same ownership proofs the harness uses (marker, inode, exact ID and labels, exact key and URL). A timeout, signal, overflow or unknown writer leaves recovery to the operator; the harness never signals a child, never kills a process group and never retries an update.

## Borrowed assertions

The September 25 donor scripts are assertion sources only and are not imported. Their SHA-256 values as pinned in the plan's source bindings: `warm-start_claude.mjs` c45b99ba255092b8ecc5937f150830b98b253e69638cab1fb1ee8b2ac436cee4, `moving-git-package_claude.mjs` a9dd891bf2b170e6dc54db12e18248a213ca0578d5d42300c3430fa6c4acddda, `alias-reinstall_claude.mjs` f965e21780cb3a6a8b6cb8ca2602c45fc44261364d84c623b4fc7948051d7490, `postflight_claude.mjs` ee53216bc6211b7a32d54fa2ae7dc853cefbf61abf1f5717b5f563fb668654f7.

## Update expectations and the continuation runner

The expected record set of `normal-update` and `settling-update` must name the run-owned repository record (`UcProbe<suffix>`) and, for `normal-update`, the Git-pin record of the owned registration, whose id is derived exactly as the product derives it (`owned_ids_codex.mjs`, compared in its control with the product's own container-name and pin-id functions). The continuation runner (U6) still judges its two updates from the outer CLI's output wording plus the product's own recovery state, not from the structured worker, because a structured proof needs the exact full record inventory of those updates, which only an observed run can supply. It clears its retain-fixtures guard only for a proven normal return (normal activation wording, no exception-path output, no recovery barrier, readable update state), and it admits against the generation the parent has itself admitted, passed with `--generation`.

## Not yet qualified on the selected host

These are source-level interpretations that fabricated controls cannot confirm. Each fails closed if it is wrong.

1. The Podman Go templates (`.HostConfig.Init`, `.State.StartedAt`, `.Store.GraphRoot`, `.Host.Security.Rootless`) on the Ubuntu Podman version.
2. `module.registerHooks` on the Ubuntu Node 24.21. Locally, on Node 25.8 and with no command invoked, the catalog builder recorded this repository's real candidate closure (70 ES modules, 346 resolution edges, 13 builtins, none outside the checkout and none from `node_modules`) and the verified hooks loaded all 70 modules from pinned bytes so that `runOuterCli` and `createBoxSupervisor` resolved. The probes' product readers (`readAgentRegistrySnapshot`, `readEdgeRoutingSelection`, `loadActiveEdgeRoutingGeneration`, `collectAgentRuntimeStates`, `applyRuntimeReadinessProjection`, `hashInstalledTree`) also import without creating any workspace state when `PLOINKY_AGENTLIB_DIR` is set. The Ubuntu Node version and the closure of the pushed commit that is actually deployed remain to be recorded.
3. The probe's use of the product readers inside the Box, in particular `loadActiveEdgeRoutingGeneration` depending on the exec environment (`PLOINKY_ROUTER_HOST_PORT`, `PLOINKY_MEDIA_HOST_PORT` and the public-host variable inherited from the container).
4. The per-entry external-health source: the Router `/health` response is used for every graph entry that requires it.
5. The exact record vocabulary of a real update; `expectedUpdates` must come from an observed inventory and may need ids beyond the repository, graph, path and default-skills names currently admitted.
6. The unprivileged `add repo`, `enable agent ... as <alias>`, `disable agent` and `uninstall repo` command forms through the outer route, and the probe agent image and manifest.
7. The Explorer smoke helpers imported in the harness process for the marker upload, and the per-gate environment (`SMOKE_*` pass-through, `SMOKE_DEPLOYMENT_MODE=box`, `SMOKE_PLOINKY_BIN`).
8. The fixture helpers of the continuation runner (locks, identity, skill export, host state) load by pathname from the pinned clean checkout after admission; they are not behind the verified import hooks.
