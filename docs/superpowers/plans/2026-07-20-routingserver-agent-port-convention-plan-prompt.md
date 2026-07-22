# Handoff Prompt — Produce a Ready-to-Implement Plan for the RoutingServer Agent-Port Convention

Paste everything below the line into a fresh Claude Code session started in
`/Users/danielsava/work/file-parser`.

---

## Your task

Turn this contract into a **ready-to-implement plan**:

```
/Users/danielsava/work/file-parser/ploinky/docs/superpowers/specs/2026-07-20-routingserver-unified-browser-proxy-requirements.md
```

Produce a plan document only. **Write no implementation code in this session.**
The single file you create is the plan itself.

Repo root for this work is `/Users/danielsava/work/file-parser/ploinky`, branch
`ploinky-proxy`. **Every path in this prompt is absolute** — use absolute paths
in your own output too. Shell commands are run from that repo root unless stated
otherwise.

## Ground rules about the source material

| Fact | Consequence for you |
| --- | --- |
| `/Users/danielsava/work/file-parser/ploinky/docs/specs/` (DS000–DS014) was **deleted on purpose** — it was outdated. | Do not restore, cite, or reason from DS specs. If you find a reference to one anywhere, treat it as stale. |
| The **codebase is the source of truth** for current behavior. | Never assert current behavior from a document. Read the code and cite absolute `file:line`. |
| The 2026-07-20 requirements doc is the **canonical target contract**. | Its invariants are requirements. Your plan implements them; it does not relitigate them — except where Step 3 below marks a decision as genuinely open. |
| That doc is a requirements/invariants contract, **not a plan**. It has 19 acceptance criteria (P01–P19), a large §19 test matrix, and §21 lists 12 undecided interfaces. | Your job is exactly the missing layer: sequencing, task breakdown, file-level changes, and runnable verification. |

## Step 1 — Resolve the blocking question before you plan anything

**The convention may be unavailable on the user's own development runtime.**
This decides the shape of the entire plan, so settle it first.

Doc §6.2 ("Backend proof") requires that a runtime prove agent-scoped network
confinement, and explicitly states host-network or host-sandbox execution is not
sufficient proof. Evidence already gathered (re-verify each):

| Observation | Location |
| --- | --- |
| seatbelt runtime: `Port resolution — with shared host network, hostPort === containerPort`, and `resolveProfileServer(..., { runtimeMode: 'host' })` | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/seatbelt/seatbeltServiceManager.js:378,380` |
| bwrap runtime: `// Process isolation — do NOT unshare network (agents need host network)`; only `--unshare-pid` is pushed | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/bwrap/bwrapServiceManager.js:315,323` |
| docker path has a `useHostNetwork` branch that suppresses publishes | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js:807` |

If an agent shares the host network namespace, then a relay dialing
`127.0.0.1:<port>` inside that agent reaches **host loopback** — precisely the
SSRF the doc forbids. By the doc's own rule the convention must then be disabled
for those agents.

Do this:

1. Determine empirically which runtime this workspace actually uses by default
   (the platform is darwin). Read the runtime-selection code; do not guess.
2. Establish whether a truly network-confined backend exists here today.
3. Then use `AskUserQuestion` to get an explicit decision from the user, e.g.:
   container-runtime-only and disabled elsewhere; or design a confined relay for
   host-network runtimes; or defer the convention until confinement exists.

Do not write the plan until this is answered — the answer changes which tasks
exist.

## Step 2 — Split the scope

The doc fuses two independent changes. Your plan must sequence them as separate
phases with separate acceptance gates, and must be explicit that Phase B does not
block Phase A.

| Phase | Content |
| --- | --- |
| **A. The agent-port convention** | The reserved path family `/<prefix>/<agent>/<port>/<path...>`, selector validation (§6.3), runtime-confined target resolution (§6.2), policy-before-dial, path rewrite after authorization, WebSocket/SSE parity. This is what the user actually asked for. |
| **B. RoutingServer rearchitecture** | Immutable content-addressed generations, authorization-to-dial leases, the private machine-call listener with replay-protected assertions, locator projection (§§9, 15, 16, 14.5). Large, valuable, and independent of A. |
| **C. Removal of superseded paths** | P16 requires deleting `additionalServerPort`, the profile-server proxy, and transport-specific target selection. From the repo root, `rg -ln "additionalServerPort\|profileServerProxy"` currently returns 19 files (~13 code, plus `/Users/danielsava/work/file-parser/ploinky/tests/unit/profileServer.test.mjs` and `/Users/danielsava/work/file-parser/ploinky/tests/unit/profileSystem.test.mjs`, plus docs). Treat as its own phase with its own regression gate. |

The user favours greenfield hard cuts, so this is about **sequencing**, not about
softening the cut. No compatibility shims — just don't land A, B, and C as one
change.

## Step 3 — Known findings to build on

These came from a prior read-only analysis. Each is labelled by how it was
established. **Re-verify every "Inferred" row yourself before relying on it.**

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Host-network runtimes make the convention an SSRF unless disabled (see Step 1). | Observed code, inferred consequence | files listed in Step 1 |
| 2 | **The relay the doc asks for already exists.** §6.2 demands "one Ploinky-owned runtime relay per agent" and §21 leaves its protocol undecided, as if it were new infrastructure. But `AgentServer.mjs` already runs inside every agent and listens on `process.env.PORT \|\| 7000`. It is already Ploinky-owned and already inside the agent's namespace. | Observed that it exists/listens; **inferred** that it is the right relay | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentCommands.js:4` (`DEFAULT_AGENT_ENTRY = 'sh /Agent/server/AgentServer.sh'`), `/Users/danielsava/work/file-parser/ploinky/Agent/server/AgentServer.mjs:1306,1505` |
| 3 | The 7000→host publish is gated on `manifestPorts.length === 0`, and `containerPortCandidates` falls back to 7000 only when the manifest declares no mappings. So for multi-port agents — exactly the ones this convention targets — port 7000 appears unpublished and the router may have no host port for it. **Not confirmed by running a multi-port agent.** | Observed gate; **inferred** consequence | `/Users/danielsava/work/file-parser/ploinky/cli/sandbox/docker/agentServiceManager.js:1308` and `:1198-1203` |
| 4 | **Port-scan oracle.** §6.3 "Health" plus §17 (`target port missing or unhealthy → 502/503`) let an authenticated user enumerate listening ports inside any agent they can name, via status/timing. §19's matrix has no test for it. | Read from the doc | doc §6.3, §17, §19 |
| 5 | **Live defect on this branch.** `handleHttpServiceUpgrade` is defined at `/Users/danielsava/work/file-parser/ploinky/cli/server/wsServiceProxy.js:147` and called at `/Users/danielsava/work/file-parser/ploinky/cli/server/RoutingServer.js:631`, but `rg "wsServiceProxy" cli/server/RoutingServer.js` returns **no import**. The call sits inside `try { … } catch (_) { socket.destroy() }`, so the resulting ReferenceError is swallowed into a client-side reset. `/Users/danielsava/work/file-parser/ploinky/docs/superpowers/plans/2026-06-26-router-websocket-proxy.md:357` specifies the missing import. A Codex session reported an e2e ECONNRESET; **that test was not re-run**. | Observed missing import; **inferred** runtime effect; failing test is **delegated/unconfirmed** | as cited |
| 6 | The reserved prefix `base-agent-additional-server` is verbose, product-flavoured vocabulary in a doc that elsewhere insists core stay generic (§3, P17). It is permanent once shipped. | Read from the doc | doc §6.1 |

How to handle each in the plan:

| Finding | Required treatment |
| --- | --- |
| #5 | Make it **Phase 0** of the plan — the first task, ahead of A/B/C, because it is independent and small. **You are planning it, not performing it.** Do not edit `RoutingServer.js`. Write the task so an implementer can execute it: the exact import to add, the exact test command to run before the fix to observe the failure, and the same command to run after. If the user wants the fix applied live, that is a separate request they will make. |
| #6 | Raise it with the user via `AskUserQuestion` **before** the prefix is baked into the plan, since it is permanent once shipped. |
| #4 | Include as either an explicit accepted-risk entry or an admin-gating task. Do not leave it unstated. |

## Step 4 — Required shape of the deliverable

Write to:

```
/Users/danielsava/work/file-parser/ploinky/docs/superpowers/plans/2026-07-20-routingserver-agent-port-convention-implementation-plan.md
```

It must contain:

| Section | Requirement |
| --- | --- |
| Resolved decisions | The Step 1 answer, the prefix name, and any of the doc's §21 items you are deciding now. Anything deferred is listed explicitly as deferred, with the constraint that must hold whenever it is decided. |
| Phase sequence | Phases 0/A/B/C as above, each with an entry gate and an exit gate. |
| Task breakdown | Numbered tasks per phase. Each task: exact absolute file paths to create or modify, the change in one or two sentences, and its dependencies on other task numbers. |
| Verification per task | **Runnable commands or observable artifacts — never quality adjectives.** From `/Users/danielsava/work/file-parser/ploinky`, the test entry point is `npm test` (→ `./tests/run-all.sh`); unit tests run as `node --test tests/unit/<file>.test.mjs`. Name the exact command and the expected result. The standard is: "Implement X. Run `node --test tests/unit/y.test.mjs`; expect N passing." |
| Test plan mapped to §19 | Map the doc's §19.1–§19.8 matrix to concrete new/changed test files by absolute path. Where a case cannot be tested in this repo today, say so and say what would be needed. |
| Acceptance mapping | Map P01–P19 to the phase and tasks that satisfy each. Any criterion not satisfied by this plan is called out explicitly. |
| Risks and open questions | Including anything you could not verify. |

## Step 5 — House rules

| Rule | Detail |
| --- | --- |
| Read-only | Analysis and planning only. No implementation code, including for Phase 0. The only file you create is the plan document. |
| No commits | Do not commit, stage, or push anything without explicit confirmation. |
| Scope | Stay inside `/Users/danielsava/work/file-parser/ploinky`. Do not touch sibling repos or `node_modules/`. |
| Claim taxonomy | Separate Observed / Inferred / Verified / Delegated. Every factual claim about code cites an absolute `file:line`. Never present a delegated or inferred result as verified. |
| Subagents | Pass absolute paths — subagent threads reset cwd between bash calls. Spot-check at least one citation per subagent reply. Consider `plan-architect` for the plan itself and `repo-explorer` (breadth: very thorough) for tracing. |
| Formatting | The user prefers tables over bullet lists in responses. |
| Commit metadata | If commits ever happen, no `Co-Authored-By`, no "Generated with", no agent attribution anywhere. |

## What "done" looks like

An engineer can open the plan, start at Phase 0 Task 1, and work straight
through without needing to make an architectural decision or guess at a file
path — and can tell after each task whether it worked by running a named command.
