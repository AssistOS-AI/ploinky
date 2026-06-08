---
name: dgskill-build
description: Establish conventions for Dynamic Code Generation skills that can answer directly or emit guarded JavaScript for transient procedural work.
---

# DGSkill Build

## Overview

Use this skill when requirements are exploratory, transient, or too fluid to justify a permanent specification-driven capability. DGSkills optimize for adaptability while preserving explicit runtime guardrails.

## Directives

1. Define whether the runtime may answer directly, emit guarded JavaScript, or choose between both modes.
2. Make sandbox policy and output normalization explicit in the descriptor.
3. Keep prompt guidance precise enough to prevent accidental expansion of scope.
4. Use this family for rapid prototyping, unusual transformations, and proportional effort responses.
5. Document how the runtime decides between textual and procedural outputs.
6. Keep coding-style, file-layout, and test-organization rules aligned with `DS001-coding-style.md`.
7. Keep `Core Content` focused on execution boundaries, mode-selection rules, invariants, and important edge cases, and use numbered `Decisions & Questions` subchapters for rationale or unresolved alternatives.

## Constraints

- Keep the skill self-contained.
- Keep persistent guidance in English.
- Prefer clear guardrails over vague autonomy.
- Keep project-wide conventions aligned with `gamp-specs` and `achilles-specs`.
- Preserve sandbox and normalization details during restructures; they are part of the contract, not expendable explanation.
- In downstream projects, do not mirror imported DGSkill family guidance under the host project's `/docs` tree.
