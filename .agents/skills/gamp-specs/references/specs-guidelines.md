# DS Specifications Guidelines

Use this reference when writing or revising the specification files under `docs/specs/*.md`.

## Purpose

Write DS specifications as stable agent-facing contracts. Focus on rules, constraints, invariants, and required outcomes rather than implementation history.

## Normative Vocabulary

- Interpret `must` as a mandatory requirement.
- Interpret `should` as a strong recommendation.
- Interpret `may` as permitted but optional behavior.

## Scope And Framing

- Treat `docs/specs/*.md` as specification documents, not as explanatory HTML documentation rewritten in Markdown.
- Keep the same architectural story as the HTML documentation when the project defines one, but express it as obligations, boundaries, and guarantees.
- Use architecture as context only; translate it into responsibilities, boundaries, invariants, and observable guarantees.
- Describe what the system, agent, or interface must do, what it must preserve, and what it must not assume.
- Keep the project aligned with the HAP framework and document only defensible requirements.

## Structure Rules

- Follow the `DS0xx-description.md` naming convention.
- Keep the numbering contiguous with no missing intermediate files.
- Always include `DS000-vision.md` and `DS001-coding-style.md`.
- Use frontmatter metadata with `id`, `title`, `status`, `owner`, and `summary` in every ordinary DS file.
- Use `Introduction`, `Core Content`, `Decisions & Questions`, and `Conclusion` in every DS file.
- In `Decisions & Questions`, use numbered Markdown subchapters such as `### Question #1: Why did we choose X?`.
- Inside each numbered question subchapter, use `Response:` for resolved design choices and `Options:` for unresolved paths that still need selection.
- When a numbered question is documented with multiple options, keep that area unimplemented in code until a human or agent selects one definitive option and updates the specification accordingly.
- Treat `matrix.md` as a generated exception: it is derived from DS metadata and does not need the ordinary four-section structure.
- Add one DS file for each active skill in the repository.
- Create additional DS files only when a distinct boundary, contract surface, or invariant set cannot be expressed cleanly inside an existing DS file.
- Keep the set of specifications proportionate to the real scope of the repository.
- Ensure the overall DS set covers scope and boundaries, obligations, invariants, dependencies, and failure or edge behavior.
- Do not restate the same contract in multiple DS files unless one file is explicitly the source of truth and the other references it.
- Make `DS001-coding-style.md` the canonical location for coding style, source layout, and modular test-organization rules.
- Make `DS001-coding-style.md` the canonical location for file-size limits, line-length guidance, and `fileSizesCheck.sh` usage.
- In downstream projects that only consume imported skills, keep DS files focused on the host project. Do not add DS files whose subject is the imported skill catalog; those instructions stay inside the local skill folders.

## Writing Standard

- Keep the prose in English.
- Prefer narrative requirement-style sections over long bullet-heavy formatting.
- Use complete sentences that express constraints and invariants clearly.
- Use lists only when the content is genuinely list-shaped.
- Reuse stable project terminology rather than inventing a parallel taxonomy for the specs.
- Keep identifiers, filenames, module names, and exact technical terms unchanged.
- Adopt a professional, academic, and defensible tone.
- Prefer affirmative descriptions of methodology and reproducible utility.
- Optimize the material for software engineers and interdisciplinary researchers.

## Technical Fidelity

- Ground each requirement in the codebase, repository guidance, or confirmed system behavior.
- Ensure each substantial requirement is defensible from code, repository guidance, or confirmed behavior.
- If code behavior, repository guidance, and documentation disagree, prefer the most authoritative and currently defensible source.
- Do not introduce speculative guarantees or contracts that the repository does not support.
- When a conflict cannot be resolved confidently, state the narrower contract and add a numbered question in the affected DS file that captures the uncertainty or alternative paths.
- The agent must not infer cross-module guarantees that are not explicitly established.

## Default Outcome

The resulting DS documents should read like durable contracts that guide future work without depending on transient implementation details or decorative explanatory text.
