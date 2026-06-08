---
name: review-specs
description: Review affected DS files step by step against the current context, instructions, and implementation, then update `Core Content` and numbered `Decisions & Questions` entries without blurring the contract boundary.
---

# Review Specs

## Overview

Use this skill when a user provides new context, explicit instructions, observed problems, or implementation changes that may affect one or more DS files. The goal is not to patch wording mechanically. The goal is to inspect each affected specification in order, confront it with the current context, and leave behind a stronger and more defensible contract set.

## Workflow

1. Build an explicit review task set before editing. Identify the affected DS files, the relevant code or skill folders, the repository guidance that constrains them, and any known contradictions or observed failures.
2. Review each affected DS step by step. For each file, compare the current text against the implementation, the user instructions, the repository guidance, and any newly supplied context.
3. Update `Core Content` first when the general approach, boundaries, invariants, special cases, or contract surface have changed. Keep `Core Content` concentrated on what the system must do, what it must preserve, and what it must not assume.
4. Push detailed rationale, tradeoffs, interpretation notes, and unresolved alternatives into `Decisions & Questions`. This section may be as long as necessary and must use numbered Markdown subchapters such as `### Question #1: ...`, `### Question #2: ...`, and so on.
5. Inside each numbered question subchapter, use `Response:` when the rationale is settled and `Options:` when the requirement is still open. If multiple options remain viable, keep that area unimplemented in code until one path is selected.
6. If a clarification is essential to the actual contract, reflect it in `Core Content` as well as in `Decisions & Questions`. Do not hide contract-shaping facts only inside the rationale section.
7. Synchronize every affected companion artifact in the same change set, including `AGENTS.md`, `README.md`, `docs/index.html`, per-skill HTML pages, local skill summaries, and tests, whenever the contract change reaches those surfaces.
8. Reread the updated DS files in order before finishing. Confirm that question numbering is consecutive within each DS, that `Core Content` still reads as the contract backbone, and that detailed reasoning sits in `Decisions & Questions` rather than leaking into unrelated sections.

## Review Standard

- Read the actual implementation and current repository guidance before rewriting a DS.
- Prefer narrowing an overclaimed requirement instead of inventing unverified guarantees.
- Preserve the distinction between the catalog repository and downstream consumer projects.
- Keep imported-skill documentation out of a downstream project's `/docs` tree unless the host project itself exposes that behavior as part of its own contract.
- Keep all persistent documentation in English.

## Output Standard

- `Core Content` establishes the general approach, important limits, special cases, invariants, and contract boundaries.
- `Decisions & Questions` holds the detailed rationale, design justifications, open questions, and option sets, and it may be arbitrarily long when that improves clarity.
- Important unresolved options remain visible in the DS until a human or agent selects one path and updates both the documentation and the code.
