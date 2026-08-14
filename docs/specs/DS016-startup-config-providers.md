---
title: DS016-startup-config-providers
summary: Defines ordered startup configuration providers, allowlisted output validation, encrypted persistence, redacted metadata, and core-owned topology boundaries.
---

# DS016 Startup Config Providers

## Introduction

An enabled agent may compute ordinary configuration that sibling agents need before startup. Ploinky owns provider ordering, validation, persistence, and the boundary that prevents provider output from controlling topology, authorization, or credentials owned by core.

## Core Content

A provider manifest must declare `providesConfig.command` and an explicit output allowlist containing valid environment names and sensitivity declarations. A consuming manifest or active profile may select provider agents through `configProviders`. Provider references must use the same repository-qualified resolution and profile rules as other manifest dependencies.

Ploinky must prepare the complete dependency graph and an early inactive targetless generation before any provider runs. The static preinstall hook runs first and must succeed. Providers then execute in their declared dependency context, after which Ploinky must persist accepted values, reload the registry, re-evaluate retained runtime hashes, rotate stale predecessor tuples, and capture the final inactive targetless generation before blocking startup waves begin.

Provider commands run on the host from the provider directory with a minimal environment containing only required runtime locators, provider identity, selected profile values, and the active workspace profile. Ploinky must remove the workspace master key, agent reusable credentials, tuple signing values, generated-secret provenance, Cloudflare and TURN credentials, and other reserved names. Core may overlay non-secret validated topology locators after stripping manifest-supplied values.

Provider stdout must be valid versioned JSON and must contain only declared outputs. Ploinky must reject invalid names, undeclared names, sensitivity mismatches, reserved Ploinky names, edge-topology names, and any generated or shared-generated secret owned by a graph node. Provider failure or invalid output aborts startup before consumers launch.

Ploinky must write accepted values through the encrypted workspace variable store; provider code must not receive master material or use `ploinky var` as the normal persistence path. Unchanged values should not churn the encrypted store. Provider metadata under `.ploinky/config-providers/` may contain identifiers, output names, sources, warnings, and timestamps but must redact every returned value.

Providers must not create or select outer publications, Cloudflare ingress, hostnames, Router targets, route generations, TURN credentials, or Box topology. Those remain coordinated core responsibilities and cannot be smuggled through ordinary environment output.

## Conclusion

Startup config providers may supply validated workspace values before dependent launch, but only Ploinky may persist them and only core may own live topology, authorization, and reusable credentials.
