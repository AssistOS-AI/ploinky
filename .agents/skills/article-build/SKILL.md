---
name: article-build
description: Refresh a research article rooted at an article folder that contains `index.html`, `assets/`, and `plan/`. Rebuild generated chapters, copy and validate SVG assets, verify bibliography support, and regenerate the final HTML incrementally from article-owned plans and sources, using only resources contained inside this skill folder.
---

# Article Build

Use this skill when the user wants to rebuild an article, review whether it is still defensible, or iteratively improve its structure after validation finds substantive gaps.

The skill must remain reusable and fully self-contained. It operates from an explicit article root and its own plan material. It must not rely on repository runtime configuration, hidden environment assumptions, or helper imports from the host project's `src/` tree.

## Expected article-root layout

The skill assumes an **article root** with this structure:

1. `<articleRoot>/index.html` - generated final article.
2. `<articleRoot>/assets/` - article-facing SVG files referenced by the HTML.
3. `<articleRoot>/plan/` - editable plans and intermediate artifacts.

Inside `<articleRoot>/plan/`, the current convention is:

1. `plan.md` - global article vision and regeneration contract.
2. `plan_chN.md` - chapter plans with frontmatter, dependency lists, and generated chapter templates.
3. `chapters/` - generated chapter markdown files used as authoritative HTML inputs.
4. `bibliography.md` - editable bibliography source of truth.
5. `bibliography/<citation-key>/` - fetched source cache plus checked-claims cache, including support snippets and verification status.
6. `assets.json` - declarative list of SVG assets to copy into `<articleRoot>/assets/`.
7. `build-manifest.json` - generated build manifest.

## Workflow

1. Identify the target `<articleRoot>` and read `<articleRoot>/plan/plan.md`.
2. Read `<articleRoot>/plan/plan_chN.md` files to understand chapter intent, declared dependencies, and generated chapter templates.
3. Read `<articleRoot>/plan/bibliography.md` and `<articleRoot>/plan/assets.json`.
4. Refresh each generated chapter markdown file under `<articleRoot>/plan/chapters/` only when its plan file or one of its declared dependencies is newer, or when the build is forced.
5. Copy article-facing SVG assets into `<articleRoot>/assets/` from the sources declared in `<articleRoot>/plan/assets.json`.
6. Validate every copied SVG. If a figure contains overlapping labels, disconnected connectors, invalid geometry, or chart titles embedded inside the SVG, repair the source asset and rebuild.
7. Verify citation support through `<articleRoot>/plan/bibliography/<citation-key>/`, preferring cached or fetched source-backed support and marking any explicit manual waivers honestly.
8. Rebuild `<articleRoot>/index.html` only when the plan files, bibliography source, generated chapters, copied assets, or bibliography validation artifacts are newer than the HTML output.
9. Write or refresh `<articleRoot>/plan/build-manifest.json` with chapter refresh status, asset refresh status, bibliography checks, and the final HTML status.
10. Emit browser-side article controls, including a print or save-PDF button, from the generated HTML.

## Local Module Review

- `skill.mjs` orchestrates incremental rebuild decisions, template resolution, asset copying, bibliography verification, and final HTML generation.
- `bibliography.mjs` manages claim extraction, cache refresh, support-snippet lookup, and verification persistence.
- `referenceCatalog.mjs` parses the bibliography source of truth.
- `renderHtml.mjs` renders the article shell, inline formatting, citations, tables, figures, and print controls.
- `svgValidation.mjs` validates SVG geometry and layout constraints.

## Agent review loop

This skill is executed by the **current agent**, so the agent must do more than blindly run a deterministic build:

1. Reread the rebuilt chapter markdown files and the final HTML.
2. Check whether the article actually communicates the intended argument, explains algorithms sufficiently, integrates figures with surrounding prose, and keeps citations local to the ideas they support.
3. If validation reveals serious gaps, revise `<articleRoot>/plan/plan.md`, the relevant `<articleRoot>/plan/plan_chN.md` files, bibliography metadata, or source SVG assets under `<articleRoot>/plan/`, then rebuild.
4. Repeat until the article is coherent, visually readable, citation-backed, and defensible.

The repository build code should remain deterministic. Structural review, plan repair, paragraph expansion, and decisions about adding diagrams or tables belong to the current agent operating this skill.

## Documentation boundary

- Keep the reusable skill contract inside this skill folder and in the catalog repository.
- If a downstream project uses this skill, do not add standalone `/docs` pages or DS files there whose topic is the imported `article-build` skill itself.
- When DS text about this workflow is revised, keep general pipeline limits, invariants, and special cases in `Core Content`, and place detailed rationale or unresolved alternatives in numbered `Decisions & Questions` subchapters.

## Content and citation rules

- The article HTML must be built from generated chapter markdown files, not directly from DS files.
- The article is theory-first. The repository appears as the reference implementation and evidence source, not as the main narrative subject.
- Main-body chapter text should not talk about file paths, module names, or npm commands.
- Use a professional, academic, and defensible tone aimed at software engineers and interdisciplinary researchers.
- Prefer affirmative descriptions of methodology and reproducible utility over negative framing or rhetorical flourish.
- Prefer one relevant citation per idea instead of appending several citations to the end of a sentence or paragraph.
- Tables should remain Markdown tables in the generated chapter markdown files, and each table should be introduced by a descriptive paragraph before rendering in HTML.
- SVG figures must remain separate files under `<articleRoot>/assets/` and should be referenced explicitly from the chapter markdown files with surrounding prose that explains why they are shown.
- Conceptual SVG diagrams must be visually clean: avoid overlapping lines, cramped labels, decorative clutter, and long sentence fragments inside figures.
- Chart SVGs must not embed their own titles; the title belongs in the surrounding prose and Markdown caption. Legends must be laid out so labels do not overlap, stacking items vertically when that is the cleaner layout.
- Bibliography verification should reuse cached checks whenever the claim text and cached source digest still match; new claims must be checked before the article is emitted.
- Source-backed checks should store supporting snippets and spans. `manual-waived` references may use curated bootstrap text only when the bibliography entry explicitly declares that waiver.
- Bibliography metadata and asset declarations must live under `<articleRoot>/plan/`, not as hardcoded data inside the skill implementation.
- Generated HTML should include a native print or save-PDF path, visible generator provenance, and an honest note that final browser header and footer behavior remains browser-controlled.

## Validation

- Run the article build twice when practical.
- On the second run, unchanged plans and unchanged inputs should leave generated chapter markdown and HTML unchanged.
- Do not manually edit generated chapter markdown files unless the source chapter plans are updated as well.
- Keep the skill self-contained even when the host repository evolves around it.
