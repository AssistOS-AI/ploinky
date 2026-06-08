# Achilles Specs Design Summary

## Introduction

This skill extends the project bootstrap rules with Achilles-specific runtime and dependency conventions. Its scope is narrower than `gamp-specs` and focuses on library integration plus LLM configuration discipline.

## Core Content

The skill requires a dependency loader example that prefers the parent directory for AchillesAgentLib resolution and falls back to `node_modules`. It requires a manual override layer for runtime configuration, a shared rule that all LLM work goes through `LLMAgent`, and an explicit task-tagging model for routing-sensitive operations. In this repository those examples live inside the skill folder so they remain portable when copied into another project's local `skills/` directory.

## Conclusion

Future Achilles-oriented repositories should apply this skill together with `gamp-specs`. If the Achilles runtime model changes, both the descriptor and the repository DS set must be updated in one revision.
