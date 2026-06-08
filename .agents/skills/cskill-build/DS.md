# C-Skill Build Design Summary

## Introduction

This skill captures the conventions for specification-driven executable skills. It is intended for capabilities whose behavior should be generated and regenerated from stable natural-language specifications.

## Core Content

The descriptor contract is deliberately small and stable, while deeper behavior is decomposed across specification files. The generated JavaScript remains secondary to the descriptor and the specs, which means repeatability and auditability take precedence over local improvisation. This family is appropriate when execution logic is substantial enough to deserve modular specifications but still benefits from generated code rather than a permanently hand-maintained runtime.

## Conclusion

Future C-Skill work should preserve the separation between contract, specification, and generated implementation. If the generation model changes, the descriptor rules and repository DS material must be updated together.
