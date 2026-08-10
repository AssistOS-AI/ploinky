# Review Prompt: Agent Log Streaming Plan

Copy the prompt below into a new Codex or Claude Code session.

```text
Perform a read-only, adversarial review of the agent log streaming implementation plan in the Ploinky repository.

Repository:
/Users/danielsava/work/file-parser/ploinky

Plan to review:
docs/superpowers/plans/2026-08-09-agent-log-streaming.md

Instructions:

1. Read the repository-root AGENTS.md and the complete canonical CLAUDE.md before doing anything else.
2. Read the complete plan.
3. Inspect the current executable code and relevant tests named by the plan. Code and tests are the source of truth; do not rely on historical specifications or generated documentation.
4. This is a review-only task. Do not edit files, implement the feature, stage changes, commit, push, deploy, start a test workspace, or run destructive commands.
5. Preserve and ignore unrelated existing worktree changes. Begin by reporting `git status --short --branch`, but do not mutate the worktree.
6. Do not run the full Ploinky suite. Read-only inspection and narrowly scoped existing tests are allowed only if needed to validate a specific claim.
7. Keep the design generic. `webmeetAgent` is only an example and must not become a hardcoded production identifier.

Review the plan against these questions:

- Does it accurately describe the current CLI dispatch, Box forwarding, enabled-agent resolver, no-wait status protocol, OCI registry records, and Bubblewrap/Seatbelt logging paths?
- Is automatic startup-log to runtime-log handoff the simplest correct behavior for diagnosing slow no-wait agents?
- Can the proposed current-marker and run-scoped-status validation select the exact active no-wait worker without trusting stale or foreign state?
- Is the source-selection precedence correct when a stale no-wait status and a valid finalized runtime coexist?
- Is using the persisted immutable container ID for Docker/Podman logs supported by the current registry lifecycle in every relevant state?
- Does the plan handle aliases, multiple instances, qualified names, and an agent named `router` without ambiguity or accidental collision?
- Is changing sandbox log paths to `.ploinky/logs/agents/<containerName>.log` necessary and sufficient? Identify any producers, consumers, tests, or diagnostics the plan missed.
- Are child-process, Ctrl+C, SIGTERM, Box signal forwarding, internal handoff cancellation, and exit-code semantics complete and testable?
- Does the proposed design remain observational and avoid creating, adopting, starting, repairing, or mutating runtime state?
- Are path traversal, shell injection, registry tampering, cross-workspace access, credential exposure, unbounded output, stale status, and process-leak risks handled?
- Are the proposed unit and integration tests sufficient without running the full suite?
- Is any part of the plan unnecessarily complex? Recommend concrete simplifications that preserve the requested behavior.
- Does the plan omit any active help, completion, Dashboard, Box, runtime, documentation, or test surface that must change?

Required response format:

1. Verdict: READY, READY WITH MINOR EDITS, or REVISE.
2. Findings ordered by severity. For every finding, cite exact repository file paths and line numbers and explain the concrete failure mode or unsupported claim.
3. Plan amendments: provide exact replacement or additional plan text for each accepted finding.
4. Missing tests: list only tests needed for an identified risk or behavior gap.
5. Simplifications: identify any state, option, helper, or compatibility behavior that can be removed.
6. Confirm explicitly that you made no file changes.

Do not implement fixes. Stop after delivering the review.
```
