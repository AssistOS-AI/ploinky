---
name: antropic-skill-build
description: Establish the self-contained portability baseline for standardized Anthropic-style skills in this repository.
---

# Antropic Skill Build

## Overview

Use this skill when creating or revising standardized Anthropic-style skills for this repository. The core rule is strict self-containment.

## Directives

1. Keep every skill fully portable inside its own folder.
2. Do not rely on external dependencies that live outside the skill folder unless the dependency is part of the agent runtime itself.
3. Keep skill-specific assets, references, templates, descriptors, and helper modules inside the skill folder.
4. Use the repository bootstrap rules from `gamp-specs` and the Achilles runtime rules from `achilles-specs` only as authoring conventions, not as runtime imports.
5. When a new Anthropic-style skill is added, update the repository skill catalog, agent guidance, DS matrix, and HTML documentation in the same change set.
6. Keep coding-style, file-layout, and modular test rules aligned with `DS001-coding-style.md`.
7. Keep `Core Content` focused on portability boundaries, general approach, invariants, and important special cases, and use numbered `Decisions & Questions` subchapters for rationale or unresolved alternatives.

## Constraints

- Preserve portability over convenience.
- Keep persistent guidance in English.
- Do not assume access to host-project source modules from inside a skill.
- Preserve local detail during restructures; a skill is not self-contained if its documentation no longer explains its local artifacts and obligations.
- In downstream projects, do not create standalone `/docs` pages or DS files about imported Anthropic-style skills; keep that material with the copied skill folder.
