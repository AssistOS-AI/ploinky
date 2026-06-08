---
name: cskill-build
description: Establish conventions for C-Skills that separate stable specification material from generated executable JavaScript.
---

# C-Skill Build

## Overview

Use this skill when a capability must be generated from explicit specifications rather than improvised inline code. C-Skills are specification-driven execution units whose descriptors and module-level specification files are the authoritative source.

## Directives

1. Treat `cskill.md` as the public contract of the skill.
2. Store the deeper behavioral specification in a `specs/` directory where each file covers one coherent module or subsystem boundary.
3. Keep the descriptor focused on routing, input format, output format, and hard constraints.
4. Treat generated executable JavaScript as an implementation artifact regenerated from the descriptor and specs.
5. Preserve repeatability, maintainability, and explicit requirement coverage over short-cycle improvisation.
6. Keep coding-style, file-layout, and test-organization rules aligned with `DS001-coding-style.md`.
7. Keep `Core Content` focused on module boundaries, general approach, invariants, and special cases, and move detailed rationale or unresolved choices into numbered `Decisions & Questions` subchapters in the relevant spec files.

## Descriptor Contract

- `Summary` identifies the capability for routing.
- `Input Format` defines expected input structure and required fields.
- `Output Format` defines expected result shape and representative success or failure outcomes.
- `Constraints` enumerates hard requirements that generated code must satisfy.

## Constraints

- Keep the skill self-contained.
- Keep persistent specification output in English.
- Align project-wide layout and coding style with `gamp-specs` and `achilles-specs`.
- Preserve descriptor detail during restructures; do not collapse module-level specification boundaries into a shallow summary.
- In downstream projects, do not duplicate imported C-Skill family guidance under the host project's `/docs` tree; keep it inside the copied skill folder.
