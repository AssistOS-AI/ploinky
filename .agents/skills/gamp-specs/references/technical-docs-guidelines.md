# Technical Documentation Guidelines

Use this reference when writing or revising the HTML documentation pages under `docs/*.html`.

## Purpose

Write for human readers. Explain what exists, why it exists, and how it behaves in practice. Keep the prose technical, specific, and operational.

## Communication Standard

- Keep all persistent output in English.
- Use a professional, academic, and defensible tone.
- Prefer affirmative descriptions of methods and working capabilities.
- Emphasize pragmatic utility and reproducible implementation guidance.
- Optimize the documentation for software engineers and interdisciplinary researchers.

## Technical Fidelity

- Check every substantive claim against the codebase before documenting it.
- Do not describe behaviors, automation steps, runtime flows, generated files, APIs, validation guarantees, or architectural layers unless they are confirmed in the implementation.
- Do not invent lifecycle stages, system boundaries, or guarantees because they sound plausible.
- If a statement cannot be confirmed from code, remove it or narrow it until it becomes defensible.
- Keep interpretations modest and close to the implementation.
- Reuse the project's stable vocabulary when canonical architecture texts or reports already define the topic.
- Keep code identifiers, filenames, module names, and exact technical terms unchanged.
- Do not present machine-specific absolute filesystem paths, usernames, home directories, or workstation-local folder layouts as if they were part of the project. Refer to repository-relative paths or project concepts unless an absolute path is itself a real, documented interface requirement.

## Editorial Standard

- Avoid prose that reads like prompt scaffolding, product marketing, or generated filler.
- Avoid meta text about how to read the page.
- Avoid slogan-like headings or generic heading formulas repeated across pages.
- Do not add sections, labels, navigation elements, or other content only to preserve a preferred visual style when the implementation does not need them.
- Adapt chapter titles to the subject of the page while preserving a logical order of ideas.
- Prefer a small number of substantial chapters over many short fragments.
- Avoid shallow one-paragraph skill pages when the skill folder contains meaningful structure that can be reviewed and documented.
- Keep explanatory text in prose with complete sentences and clear argumentative flow.
- Use lists only when the content is genuinely list-shaped.
- Avoid unexplained abbreviations in general explanatory prose.

## Examples And Callouts

- Use examples when abstract explanation is insufficient.
- Keep examples minimal for starting templates or baseline usage.
- Use extended examples only when optional behavior needs to be shown in context.
- Reserve callout boxes for operationally important information.
- Do not use callouts for decorative emphasis.

## Visual And Responsive Rules

- Keep the reading column comfortable on desktop.
- Set the HTML page title and the visible site/page title to `[project name] Documentation`.
- Prefer a consistent documentation shell with a sidebar or a header-based navigation system.
- Use one primary navigation system per documentation set. Choose either a sidebar or a header-based navigation system based on the project's needs, but do not present both as parallel primary navigation.
- Keep navigation uniform across the HTML pages so moving between files does not change the navigation model unexpectedly.
- Do not repeat navigation links redundantly inside the page body or page header when the same destination is already clearly available in the sidebar or primary navigation shell.
- Prefer full-page documents with substantial sections that read like chapters in a book.
- Do not break the documentation into fragmented card grids or small disconnected components when a continuous reading flow is more appropriate.
- Make pages readable as long-form technical documents, with well-defined sections.
- Ensure navigation supports orientation without competing visually with the main text.
- Include breadcrumbs that let the reader return to `index.html`.
- Keep links visibly identifiable in prose without relying on hover state.
- Avoid dashboard-like UI patterns unless they solve a real documentation problem.
- Collapse layouts on tablet and mobile before text becomes cramped.
- Do not surface workstation-local absolute paths in page chrome, footers, breadcrumbs, captions, or explanatory prose.
- Ensure the HTML navigation exposes a stable path to the specs entry point.
- Ensure the HTML navigation exposes a stable path to the skill catalog.
- If a page links to the specs area, route that navigation to `matrix.md` through `docs/specsLoader.html?spec=matrix.md` or an equivalent valid specs entry flow.
- Ensure readers can reach each DS file from `matrix.md`.
- When documentation discusses coding style or test organization, point readers explicitly to `DS001-coding-style.md`.
- When documenting a downstream project that merely consumes imported skills, keep `docs/` focused on the host project and avoid standalone pages about those imported skills. Keep skill-specific agent guidance inside the copied skill folders instead.
- When explaining a runtime flow or generation pipeline, prefer a compact visual diagram over an ASCII block in `<pre><code>` when the diagram improves clarity.
- Keep diagrams technically exact, visually restrained, and readable on mobile.
- Prefer inline Mermaid definitions (`<pre class="mermaid">`) over static SVG or ASCII art for architecture diagrams, data-flow diagrams, component relationships, sequence diagrams, and state machines. Mermaid definitions are text, so they stay maintainable alongside the code they describe.
- Do not use ASCII box-drawing characters (`─`, `│`, `┌`, `└`, etc.) for diagrams. Browser monospace fonts do not render them at consistent widths, producing broken alignment. Use Mermaid instead.
- Keep Mermaid diagram definitions concise. Use short node labels and let the layout engine handle positioning. Do not force coordinates or override the automatic layout unless the default result is unreadable.
- Reserve static SVG files under `docs/assets/` for diagrams that need precise custom layout, branding elements, or visual detail that Mermaid cannot express.
- If static SVG diagrams are used, shorten, wrap, or fit labels so text stays inside its visual container.
- When showing a representative directory layout, prefer a visual tree component over a raw ASCII directory dump in `<pre><code>` when the tree is easier to scan.
- Preserve the real file and folder names in any directory tree component.

## Default Outcome

The resulting HTML page should help a technical reader understand the real system faster, without decorative prose, speculative claims, or UI patterns that distract from the text.
