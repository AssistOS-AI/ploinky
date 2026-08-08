# Ploinky Repository Contract

These instructions govern the complete Ploinky repository. This file is the canonical Ploinky instruction source; `AGENTS.md` is only a pointer to it.

## Source of truth

Treat executable code and tests as the only source of truth for current Ploinky behavior. Historical DS/specification files and generated HTML may provide background, but do not use them to determine, justify, or change current behavior, and do not update them as part of behavior work.

## Non-negotiable runtime and security invariants

1. Keep Ploinky generic. Core routing, lifecycle code, and WebChat must not hardcode optional agent identifiers, model/provider tags, or agent-owned tool names.
2. Resolve one exact workspace identity per Box. A Box must never discover, adopt, mutate, or report another workspace's state.
3. Preserve the outer Box network boundary: publish only the loopback Router TCP surface and one wildcard LiveKit UDP surface targeting the in-Box listener on `7882`; the physical-host UDP port may be selected independently. Do not add a third publication, expose agent/Soul/port `7000` services directly, or expose the Router's private `8081` surface outside the Box.
4. Preserve the rootless, unprivileged runtime. Enforce the expected immutable image identity, read-only source mounts, and an init/reaper. Do not use privileged mode, SUID/setuid, file capabilities, or relaxed confinement to make a deployment pass.
5. The host `ploinky` process owns the outer Box. The in-Box `ploinky-local` process owns nested agents and must never recursively create another Box.
6. Serialize workspace mutations with the workspace lock. Revalidate immutable identity immediately before mutation, bound rollback, and declare readiness only when the complete manifest graph is ready or has reached its declared no-wait terminal state and every required external health check passes.
7. Routing fails closed. Apply the same authenticated route policy, caller ACL, exact active generation/lease checks, and replay protection to HTTP, SSE, and WebSocket traffic.
8. Confine credentials. Never inject reusable agent credentials into host or `none` runtimes. Relay/channel credentials must be fresh, generation-bound, delivered only through the private confined channel, and absent from logs, persisted state, and test artifacts.
9. A `ploinky-proxy` deployment must use the exact remote `ploinky-proxy` branch in every affected repository, including the AchillesAgentLib checkout actually loaded at runtime. Prove the loaded AgentLib bytes and repository revisions; a manifest claim alone is insufficient. Branch fallback is forbidden.
10. Preserve the versionless semantic Box identity. Do not turn schema or runtime revisions into incrementing public Box names.

## On-demand cross-repository `ploinky-proxy` gate

Do not automatically deploy Explorer or run the Playwright E2E gates after each `ploinky-proxy` change. Run this cross-repository gate only when the user explicitly requests the deployment or E2E validation in the current task. Normal scoped unit, integration, and static verification still applies to every change.

When the user requests this gate, all steps below are mandatory against the exact pushed candidate revisions. Do not infer an E2E request from a code change, a prior task, or the existence of this procedure.

### 1. Pin the candidate

Commit and push every participating candidate revision first because Ploinky resolves remote branches. Record the exact `origin/ploinky-proxy` commit for every affected/deployed repository, its configured upstream, the expected immutable Box image identity, and the release manifest used by the Copilot gate. Do not test uncommitted source and do not silently mix branch heads from different candidate generations.

### 2. Recreate the dedicated local fixture

Use only `~/work/testExplorerFresh`. Positively identify that exact path and the Box, containers, networks, and volumes owned by its previous test deployment. Remove the previous deployment and its test-owned files and volumes, then recreate the directory as a genuinely fresh workspace. Never delete or reuse resources belonging to another workspace or environment; ambiguous ownership or non-test data is a blocker.

Do not reuse a prior Box, generation, repository checkout, volume, release manifest, browser profile, or E2E artifact directory. Preserve evidence outside tracked source directories.

### 3. Deploy Explorer with the canonical command

The deployment command is literal:

```sh
cd ~/work/testExplorerFresh
ploinky start explorer
```

Do not add arguments or flags to this deployment command, including `--branch`, `--branch-fallback`, `--repo-branch`, or `--reset-repos`. Branch selection, checkout updates, and candidate pinning are separate preparation steps and must not be encoded as `ploinky start explorer` arguments. Do not substitute a manual compose/podman launch or an already-running deployment.

Before testing, prove all of the following:

1. The entire declared Explorer graph is ready, including required external health checks.
2. Every deployed repository is clean, tracks `origin/ploinky-proxy`, and is at the recorded candidate commit.
3. The running Box has the expected immutable image identity and fresh generation.
4. The running AchillesAgentLib bytes come from its recorded `ploinky-proxy` candidate revision.
5. The network publications and runtime privileges still satisfy the invariants above.

Any fallback, detached/mixed revision, stale generation, unclean checkout, missing agent, or readiness exception invalidates the deployment.

### 4. Run the three separate headless Playwright gates

Run the authoritative suite from `AssistOSExplorer/tests/smoke` against the fresh local origin (normally `http://127.0.0.1:8080`). Use a new `SMOKE_RUN_ID` and artifact directory for each gate, Chromium headless mode, `--workers=1`, and `--retries=0`.

| Gate | Required test and proof |
| --- | --- |
| Confidential document in OnlyOffice | Run `specs/50-onlyoffice-dpu.spec.mjs` with `SMOKE_ONLYOFFICE=1`, filtered to `Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart`. Create a `.doc` or `.docx` under `/Confidential/My Space`, edit it in OnlyOffice, prove the save/callback completed, reopen it, and prove the marker persisted. Either extension satisfies this gate. |
| Copilot | Run `specs/05-copilot-folder-launch.spec.mjs` with `SMOKE_RELEASE_MANIFEST` and exact Box/image/repository pins. It must pass the release-bundle verifier and prove the approved folder-launch flow against the current generation. |
| WebMeet | Run `specs/30-webmeet-room-chat.spec.mjs` filtered to `two Explorer accounts can join one room and exchange chat`, with `SMOKE_WEBMEET_HEADLESS=1`, `SMOKE_WEBMEET_MEDIA=1`, and the strict media timeout. Prove both accounts, chat/DataChannel exchange, ICE/RTP media, and cleanup. |

Each command must discover exactly one intended test and finish `1 passed`, with zero skips, retries, ignored browser/page errors, or softened assertions. A command that reports no matching tests, a skipped test, or only setup success has failed the gate.

### 5. Failure and evidence policy

Save the candidate commit map, image identity, generation, deployment/readiness proof, Playwright output, traces, screenshots, and cleanup result. Do not store credentials in evidence.

If a requested deployment or gate fails, do not waive, retry around, or narrow the invariant. Stop, preserve the evidence, report the failure, and wait for an explicit user request before another deployment or E2E run. If the user requests a retry after a fix, commit and push the new candidate, delete the failed fixture, redeploy from scratch, and rerun all three gates. Passing results from an earlier generation or revision cannot be carried forward.
