# DGSkill Build Design Summary

## Introduction

This skill defines the dynamic end of the repository skill spectrum. It exists for tasks where flexibility is more valuable than a durable specification-driven implementation artifact.

## Core Content

The descriptor must explain when the LLM may remain textual and when it may emit temporary JavaScript for execution in a guarded environment. Prompt guidance, sandbox policy, and normalization rules therefore become first-class design elements. This family is intentionally optimized for agility, unusual requests, and one-off transformations where heavier formalization would be disproportionate.

## Conclusion

Future DGSkill work must preserve guarded execution and explicit mode selection. If the sandbox or routing policy changes, the descriptor and DS material must be revised together.
