# Handoff Prompt — Produce a Ready-to-Implement Plan for Ploinky Box

Paste everything below the line into a fresh Claude Code session started in
`/Users/danielsava/work/file-parser/ploinky`.

---

## Your task

Turn this approved invariant register into a **ready-to-implement plan**:

```
/Users/danielsava/work/file-parser/ploinky/docs/superpowers/specs/2026-07-21-ploinky-box-invariants.md
```

Produce a plan document only. **Write no implementation code in this session.**
The single file you create is the plan itself:

```
/Users/danielsava/work/file-parser/ploinky/docs/superpowers/plans/2026-07-21-ploinky-box-implementation-plan.md
```

Repo root for this work is `/Users/danielsava/work/file-parser/ploinky`, branch
`ploinky-proxy`. **Every path in this prompt is absolute** — use absolute paths
in your own output too. Shell commands run from that repo root unless stated
otherwise. Read the register **fully** before planning; every ID used below
(N1–N7, LAY, BIN, PRT, IDN, IMG, VOL, NST, CMD, RTE, MAN, PUB, Q1–Q6,
VER-1..VER-16) is defined there.

## Ground rules about the source material

| Fact | Consequence for you |
| --- | --- |
| The register is the **sole normative input**, marked approved. | Its invariants are requirements. Your plan implements them; it does not relitigate them — except where section 15 marks a question as genuinely open. |
| `/Users/danielsava/work/file-parser/ploinky/docs/superpowers/specs/2026-07-21-ploinky-box-container-invariants.md` is **superseded, provenance-only** (its Status header says so). | Do not cite it, reason from it, or mine it for extra requirements. Everything the owner kept from it is already merged into the register. |
| The register is deliberately **standalone**: the retired `ploinky-box` git branch and any 2026-07-15 design material are history, not input. | Do not cite either. If you find a reference to them anywhere, treat it as stale. |
| `/Users/danielsava/work/file-parser/ploinky/docs/specs/` (DS000–DS014) was deleted on purpose. | Do not restore, cite, or reason from DS specs. |
| The **codebase is the source of truth** for current behavior. | Never assert current behavior from a document. Read the code and cite absolute `file:line`. |
| The register's section 16 preamble describes the test layout as `tests/unit`, `tests/integration`, `tests/e2e`, `npm test` → `tests/run-all.sh`. | Verified accurate on 2026-07-21: all four exist (`ls /Users/danielsava/work/file-parser/ploinky/tests/`; `package.json` has `"test": "./tests/run-all.sh"`), alongside stage scripts such as `tests/test_all.sh`. Ignore any stale workspace references to `tests/fast/` or `tests/smoke/` — neither exists on this branch. Re-verify cheaply, then plan verification commands against this layout. |

## Facts already verified on 2026-07-21 (cheap to re-verify; do so where marked)

| # | Fact | How established | Consequence |
| --- | --- | --- | --- |
| 1 | The published image `docker.io/assistos/ploinky-box:runtime` carries runtime-contract label `3` (amd64 + arm64 index present). | Docker Hub API inspection, 2026-07-21 | The first publish under the new plan is a **hard cut for every existing box** (IMG-2). No compatible published contract-5 image exists; do not plan around one. |
| 2 | The only sanctioned image build path (N7) is the `publish-ploinky-box-image.yml` workflow in `/Users/danielsava/work/file-parser/container-image-builds/.github/workflows/` (GitHub repo `AssistOS-AI/container-image-builds`): manual `workflow_dispatch` with exact 40-character source SHAs, native amd64 + arm64 gate jobs, then a merge job moves the `runtime` tag. | Read that file; re-verify | The plan contains **no Dockerfile or image-build task inside the ploinky repo**. Image obligations enter the plan only as register section 8 validation duties plus a cross-repo coordination task (below). |
| 3 | That workflow's source gates reference `sources/ploinky/container/runtime-contract.mjs` and sibling `container/` paths — a layout absent from this branch (`git ls-files container/` returns nothing). | Read + `git ls-files`; re-verify | Per Q2's constraint, the workflow's gate paths move to `ploinky-box/` **in the same change that mints the new contract version**. Plan this as an explicit cross-repo coordination task — planned, not performed, in this repo's plan. |
| 4 | The `package.json` `bin` map's **only** entry is the stale `p-cloud` (`package.json:8`, pointing at `./bin/p-cloud`); `ploinky` and `ploinky-local` are not published in the map at all today. | `grep -n p-cloud /Users/danielsava/work/file-parser/ploinky/package.json` on 2026-07-21; re-verify | The packaging task removes `p-cloud` and publishes `ploinky` + `ploinky-local` (BIN-5). |
| 5 | Register section-4 seam anchors were spot-verified: router `PORT` default `8080`, `PLOINKY_PUBLIC_BIND` default `127.0.0.1`, authority mandatory on wildcard bind (`cli/server/RoutingServer.js` ~80–86); `PRIVATE_LISTENER_PORT = 8081` (`cli/server/privateListener.js:11`); `PLOINKY_DISABLE_HOST_SANDBOX` (`cli/utils/runtime/sandboxRuntime.js:3`); podman-before-docker probe (`cli/sandbox/docker/common.js` ~86–91); `ploinky_<repo>_<agent>_<projectDir>_<cwdHash>` naming (`cli/sandbox/docker/common.js` ~201). | Read on 2026-07-21; line numbers may drift — re-verify before citing | These seams are consumed **as-is** (N5). Any box capability they cannot support is an escalation recorded as an open question, never a core edit. |
| 6 | `bin/` currently holds the entry shims the register's BIN group governs (`ploinky`, `ploinky-shell`, plus auxiliaries `p-cli`, `psh` per BIN-6). | Register; verify with `ls /Users/danielsava/work/file-parser/ploinky/bin/` | The packaging tasks touch exactly these plus `package.json` — nothing else outside `ploinky-box/` (N5, VER-2). |

## Owner decisions already made — do not reopen

| Decision | Content |
| --- | --- |
| N6 command surface | No `ploinky box *` namespace. `ploinky start` brings up the box and the ploinky containers inside it (forwarded core `start`, CMD-5 port grammar). `ploinky status` reports the ploinky agents inside the box plus outer box state, read-only, never reconciling. `ploinky stop` gracefully stops in-box core services and nested agent containers within a bounded timeout, then stops the outer box; idempotent; preserves the box container and every named volume. `ploinky destroy` destroys the entire box container; named volumes survive (VOL-3). Unboxed operation always uses `ploinky-local`; `ploinky` never falls back to direct host execution. Core's shadowed verbs stay reachable per CMD-8. |
| N7 image provenance | The box image is built and published only by triggering `publish-ploinky-box-image.yml` in `AssistOS-AI/container-image-builds`. |
| Recursion mechanism | The image-baked in-box marker (BIN-4, IMG-8) is the decided mechanism; VER-5 tests it. |
| Deferred slice | PUB-1..PUB-5 (publication/tunnel) are **out of this plan's build scope**. Nothing in the plan may contradict them. |

## Decisions the plan must make (label each "proposed — owner may override")

| Open item | What the plan must do |
| --- | --- |
| Q3 — routing of `p-cli` and `psh` | BIN-6 requires the plan to assign each one boxed or local routing, with tests either way. Propose an assignment with a one-line rationale per binary. |
| Q4 — in-box REPL as-is vs wrapped | CMD-3 fixes observable behavior; propose the implementation choice within LAY-2 and N5. |
| Q2 — new runtime-contract version value | Mint the value (must differ from every previously published label, including `3`; the workflow currently gates `5` — see Fact 3). Pair it with the cross-repo gate-path migration task. |
| Q1 — bridge-networked nested agent → private listener `8081` | Stays open. Note it in risks; **no task may depend on resolving it**. |
| Q5 — UDP media consumer sequencing | Out of scope; PRT-3's reserved mapping exists from day one regardless. Say so. |
| Q6 — nested-podman issue not fixable at image level | Restate the escalation rule in the risks section. |

Use `AskUserQuestion` only if you discover a genuine register conflict or a
blocking ambiguity; otherwise propose and label.

## Required shape of the deliverable

| Section | Requirement |
| --- | --- |
| Resolved decisions | The Q2/Q3/Q4 proposals above, each labeled "proposed — owner may override", plus anything else you had to fix during planning. Deferred items listed explicitly with the constraint that must hold when they land. |
| Phase sequence | Ordered slices with explicit dependencies, each with an entry gate and an exit gate. A sensible spine: scaffolding + identity/engine discovery → runtime-contract validation + volumes → passthrough + command routing → host-special verbs + locking → packaging/bin rewiring → real-engine + release gates. Yours may differ; justify the order you pick. |
| Task breakdown | Numbered tasks per phase. Each task: exact absolute file paths to create or modify, the change in one or two sentences, and its dependencies on other task numbers. Implementation files live **only** under `/Users/danielsava/work/file-parser/ploinky/ploinky-box/`; packaging tasks touch only `bin/*` and `package.json` (N5). Zero edits under `cli/`, `Agent/`, `dashboard/`. |
| Verification per task | **Runnable commands or observable artifacts — never quality adjectives.** Name the exact command and the expected result against the real test layout you verified. |
| VER coverage matrix | Map every task to at least one of VER-1..VER-16 and show that **all sixteen** are covered. Where a check can only run outside this repo (VER-13 runs inside the publish workflow's native-arch gates), say so and name the workflow step that satisfies it. |
| Cross-repo coordination | One section for the `container-image-builds` changes (gate paths `container/` → `ploinky-box/`, new contract version, image metadata per register section 8). **You are planning it, not performing it** — the plan describes the exact edits and the trigger procedure (N7), and marks it as executed in that repo with owner approval. |
| Release gate | Final section covering VER-12 (end-to-end smoke: empty directory → `ploinky start <agent>` → request through host loopback reaches an agent route; same route via `ploinky-local` without a box) and VER-13 (multi-architecture, via the workflow), plus the IMG-2 hard-cut note for existing contract-3 boxes. |
| Risks and open questions | Q1, Q5, Q6 treatments, anything you could not verify, and any register discrepancy you found (e.g. the section-16 test-layout description vs reality). |

## House rules

| Rule | Detail |
| --- | --- |
| Read-only | Analysis and planning only. No implementation code. The only file you create is the plan document. |
| No commits | Do not commit, stage, or push anything without explicit confirmation. |
| Scope | Stay inside `/Users/danielsava/work/file-parser/ploinky`, with one read-only exception: `/Users/danielsava/work/file-parser/container-image-builds/.github/workflows/publish-ploinky-box-image.yml`. Do not touch sibling repos or `node_modules/`. |
| Claim taxonomy | Separate Observed / Inferred / Verified / Delegated. Every factual claim about code cites an absolute `file:line`. Never present a delegated or inferred result as verified. |
| Subagents | Pass absolute paths — subagent threads reset cwd between bash calls. Spot-check at least one citation per subagent reply. Consider `plan-architect` for the plan itself and `repo-explorer` (breadth: very thorough) for tracing. |
| Formatting | The user prefers tables over bullet lists in responses. |
| Commit metadata | If commits ever happen, no `Co-Authored-By`, no "Generated with", no agent attribution anywhere. |

## What "done" looks like

An engineer can open the plan, start at Phase 1 Task 1, and work straight
through without needing to make an architectural decision or guess at a file
path — and can tell after each task whether it worked by running a named
command. Every VER-1..VER-16 obligation is traceable to at least one task, and
the additive boundary (VER-2: empty `git diff` over `cli/`, `Agent/`,
`dashboard/`; only `bin/*` and `package.json` outside `ploinky-box/`) survives
the whole plan.
