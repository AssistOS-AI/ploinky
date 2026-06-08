# GAMP Specs Design Summary

## Introduction

This skill is the repository bootstrap authority for documentation layout, agent guidance, DS naming rules, and coding-style anchoring. It preserves the former `gamp-structure` behavior while extending it with stronger synchronization requirements across the skill catalog.

## Core Content

The skill owns the repository rules that tie `AGENTS.md`, `docs/`, and `docs/specs/` together. It defines the mandatory three-digit DS naming convention, the requirement to keep the DS sequence contiguous with no skipped numbers, the requirement to keep all persistent content in English, the use of SVG diagrams under `docs/assets/`, and the mandatory `Decisions & Questions` section with numbered question subchapters in ordinary DS files. It also defines the repository-level maintenance rule that when new skills are added, the agent guidance, the generated DS matrix, the coding-style pointers, and the HTML documentation must all be updated in the same change set. Repository-wide example code is kept inside skill folders rather than in a shared root `src/` tree, and downstream consumer projects must keep imported-skill documentation inside those skill folders rather than under the host project's `docs/`.

## Conclusion

Future structural bootstraps must treat this skill as the entry point for repository documentation policy. Any change to project layout, DS policy, coding-style authority, or agent-facing synchronization rules must be reflected here first.
