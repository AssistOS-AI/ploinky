# Antropic Skill Build Design Summary

## Introduction

This skill defines the portability baseline for the repository skill set. It exists so that each Anthropic-style skill can travel as a self-contained unit without hidden imports or repository-coupled assumptions.

## Core Content

The design insists that every runtime artifact needed by a skill must remain inside its own folder. Shared repository conventions still exist, but they govern authoring rather than runtime imports. This approach allows skill folders to remain portable while the repository still enforces consistent documentation, DS policy, and Achilles runtime conventions.

## Conclusion

Future standardized skills should start from this portability contract. If a skill needs broader runtime coupling, that deviation must be documented explicitly in both the descriptor and the DS set.
