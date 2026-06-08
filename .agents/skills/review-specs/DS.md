# Review Specs Design Summary

## Introduction

This skill defines the repository workflow for reviewing and strengthening DS files in response to new context, instructions, or observed problems. It exists because specification maintenance requires a repeatable review method, not just ad hoc rewrites.

## Core Content

The skill requires an explicit task set, step-by-step review of each affected DS, and a clear split between contract backbone and rationale. `Core Content` carries the general approach, limits, invariants, and special cases. `Decisions & Questions` carries the detailed reasoning, justifications, and unresolved alternatives through numbered question subchapters. Important clarifications that change the contract must be reflected in both places when appropriate.

## Conclusion

Future specification reviews should preserve this distinction between contract and rationale. If the review workflow changes, the descriptor and the repository DS material should be updated together.
