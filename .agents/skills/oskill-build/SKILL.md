---
name: oskill-build
description: Establish conventions for orchestration skills that coordinate other skills through explicit preparation and execution loops.
---

# O-Skill Build

## Overview

Use this skill when a capability is primarily a coordinator rather than a domain worker. O-Skills map a high-level goal into a declared sequence of calls to other skills.

## Descriptor Contract

1. `#[skill-name]` is mandatory and must match the exact skill name.
2. `## Description` is mandatory and defines capability, use conditions, and trigger vocabulary.
3. `## Preparation` is optional and must be a numbered list if present.
4. `## Allowed Preparation Skills` is optional and must be a hyphenated list if present.
5. `## Instructions` is mandatory and must be a numbered list.
6. `## Allowed Skills` is mandatory and must be a hyphenated list.
7. `## Session Type` is optional and may be `soplang` or `loop`, defaulting to `soplang`.

## Directives

- Keep the orchestration layer declarative.
- Use the allowed-skills lists as the explicit downstream toolbelt.
- Make preparation context loading separate from the main execution loop.
- Preserve auditability by exposing planner constraints in the descriptor rather than burying them in freeform prose.
- Keep coding-style, file-layout, and test-organization rules aligned with `DS001-coding-style.md`.
- Keep `Core Content` focused on orchestration limits, general control flow, invariants, and special cases, and use numbered `Decisions & Questions` subchapters for rationale or unresolved planning choices.

## Constraints

- Keep the skill self-contained.
- Keep persistent guidance in English.
- Align repository-level bootstrap and coding rules with `gamp-specs` and `achilles-specs`.
- Preserve the descriptor sections during restructures; omitting allowed-skills or session-type detail is a contract loss.
- In downstream projects, keep imported O-Skill family guidance inside the copied skill folder rather than in the host project's `/docs` tree.
