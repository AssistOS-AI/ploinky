# Scope

These instructions govern the complete Ploinky repository. The DS specifications are the source of truth for runtime behavior, interfaces, security boundaries, coding conventions, and verification requirements.

# Mandatory Reading Order

1. Read `docs/specs/DS000-vision.md` for repository scope and boundaries.
2. Read `docs/specs/DS001-coding-style.md` for coding style, module layout, file-size rules, and test organization.
3. Read the DS files relevant to the subsystem being changed.
4. Read the corresponding HTML documentation under `docs/` before changing documented behavior.

# Current Skill Catalog

This repository does not own a local skill catalog. Skills supplied by an external agent environment are tooling, not Ploinky runtime modules, and must not receive standalone Ploinky DS files or HTML pages.

# Repository Rules

- Keep Ploinky generic: do not hardcode optional agent ids, provider tags, or agent-owned tool names into core routing or WebChat.
- Preserve router authentication, workspace confinement, agent identity, and fail-closed route/tool policy.
- Use ES modules and the conventions in `docs/specs/DS001-coding-style.md`.
- Write documentation, specifications, and code comments in English.
- When source behavior changes, update the affected HTML documentation and DS specifications in the same change.
- Keep DS numbering contiguous and regenerate `docs/specs/matrix.md` from DS frontmatter.
- Use numbered `Decisions & Questions` subchapters in ordinary DS files; do not maintain a separate decision log.
- Update this file if repository-owned skill folders are introduced or removed.

# Runtime Defaults

Ploinky is a workspace-local agent runtime. The router owns public application surfaces, authenticated WebChat state is confined to the selected workspace directory, and agent-specific behavior remains owned by installed agent repositories and manifests.

# Key Paths

- `docs/index.html` — documentation entry point.
- `docs/specsLoader.html?spec=matrix.md` — specification browser.
- `docs/specs/` — authoritative DS specifications.
- `cli/server/` — router and first-party browser surfaces.
- `cli/server/webchat/` — WebChat browser modules.
- `tests/unit/` — Node unit tests.
- `tests/` — stage-oriented integration and lifecycle checks.
