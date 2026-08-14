---
title: DS000-vision
summary: Defines Ploinky as a workspace-bound runtime that turns repository-described agents into an isolated, routable, and operable system.
---

# DS000 Vision

## Introduction

Ploinky enables an operator to assemble repository-described software agents into one local workspace, run them through controlled runtimes, and reach them through command-line, browser, and programmatic interfaces. The product must remain independent of any particular optional agent, model provider, backend tag, or agent-owned tool name.

## Core Content

The public `ploinky` command must reconcile one managed outer Box for the canonical workspace. The in-Box `ploinky-local` process must own repository discovery, enabled-agent state, dependency preparation, agent runtime lifecycle, and the Router. This ownership split must prevent recursive Box creation and must keep physical-host resource management outside agent-controlled code.

Ploinky must derive behavior from repository manifests and workspace configuration, not from product-specific branches in core routing or lifecycle code. Operators must be able to install repositories, enable one or more agent instances, start their dependency graph, interact with the resulting services, inspect status and logs, stop execution, and remove runtime state while preserving the durable workspace data defined by the relevant lifecycle contract.

Security and continuity are part of the product outcome. Every mutating operation must remain bound to one exact workspace identity, agent and route activation must use coordinated generation state, credentials must remain confined to their intended runtime and request direction, and public reachability must not bypass authentication or policy.

Executable code and tests are the authority for actual behavior. The DS set defines the required contract and must be updated when implementation changes affect user outcomes, public interfaces, architecture, security boundaries, or major hidden functional consequences. Specifications must remain consecutively numbered, and all persistent documentation, specifications, and comments must be written in English.

## Conclusion

Ploinky succeeds when an operator can reproducibly turn agent repositories into one secure workspace service without managing container addresses, dependency order, routing generations, or credential exchange manually.
