---
name: achilles-specs
description: Extend repository bootstrap guidance with AchillesAgentLib integration, dependency resolution, runtime configuration, LLM conventions, and coding-style additions that must flow into `DS001-coding-style.md`.
---

# Achilles Specs

## Overview

Use this skill when a project must adopt AchillesAgentLib conventions, runtime wiring, and LLM configuration rules in a consistent and auditable way. This skill extends `gamp-specs`; it does not replace it.

## Directives

1. Authorize the use of AchillesAgentLib and document that authorization in `AGENTS.md` and `DS001-coding-style.md`.
2. Keep the example dependency resolver inside this skill folder, for example `examples/depsLoader.mjs`, so the skill remains portable when copied into another project's `skills/` directory.
3. Define a manual override mechanism for core runtime configuration so repository code can override environment-based defaults.
4. Require all LLM interactions to use the `LLMAgent` class configured through runtime configuration and environment variables.
5. Apply task metadata tags for routing-sensitive work such as documentation, specification work, orchestration, bootstrap, and testing.
6. Record the model tier strategy in a dedicated DS file.
7. When this skill is applied to a downstream project, ensure that project has a clear runtime structure such as `src/`, `tests/`, and `data/`, while keeping the example implementation in this repository inside the skill folder.
8. When updating DS material about Achilles integration, keep the general runtime contract, boundaries, invariants, and special cases in `Core Content`, and move detailed rationale or unresolved tradeoffs into numbered `Decisions & Questions` subchapters.

## Documentation Obligations

- Append the Achilles-specific coding-style and runtime rules to `DS001-coding-style.md` rather than leaving them implied in skill descriptors.
- Keep the HTML documentation aligned with the runtime helpers that actually exist inside this skill folder.
- Preserve the detail that manual overrides exist in addition to environment-based configuration.
- In downstream projects, document Achilles integration only where it affects the host project. Do not create standalone `/docs` pages or DS files there whose subject is `achilles-specs` itself.

## Constraints

- Keep persistent project output in English.
- Do not assume AchillesAgentLib is always installed inside the current repository.
- Do not introduce external runtime dependencies without explicit user approval.
- Keep implementation guidance aligned with `gamp-specs`.
