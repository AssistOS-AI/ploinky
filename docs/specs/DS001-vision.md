---
title: DS001-vision
summary: Defines Ploinky as an application for creating and using standardized agents in isolated, controllable, observable environments without installing their dependencies directly on the host system.
---

# DS001 Vision

## Introduction

Ploinky helps developers create, test, and use software agents without installing each agent's libraries, applications, and transitive dependencies directly on the host system. An agent runs in a controlled environment, follows a standard repository structure, and exposes supported interfaces through which users, other agents, and Ploinky can interact with it.

The product exists because experimental software often requires large or unfamiliar dependency trees whose quality and security are difficult to evaluate in advance. This risk is especially visible in ecosystems such as npm, where a prototype can introduce many transitive packages into a developer's machine. Ploinky makes the isolated agent environment the normal place for that experimentation.

## Core Content

### Safe agent creation and experimentation

Ploinky must let a developer turn an idea into an agent, run it, inspect its behavior, and discard or rebuild its runtime without installing the agent's dependencies into the host operating system. A prototype must be able to carry its own runtime requirements while the developer's workspace remains the durable source of code and selected data.

The default workflow must make isolation easier than direct host installation. A developer should not need to design container networking, dependency mounts, process supervision, or communication plumbing before the first useful agent can run.

### Isolation as a product foundation

Ploinky must use two containment boundaries. Ploinky itself runs inside a managed outer Box associated with one workspace, and each agent runs in its own inner container or supported sandbox. The outer Box limits what the Ploinky runtime places on the host, while the inner runtime separates one agent's processes and dependencies from the Box and from other agents.

An agent compromise must not grant host access through permissive Ploinky defaults. Managed runtimes must remain rootless and unprivileged, expose only approved mounts and network paths, and keep agent listeners behind Ploinky-owned routing. This containment goal reduces the effect of vulnerable or malicious dependencies, but it does not claim protection from vulnerabilities in the host kernel, container engine, or another component below Ploinky's isolation boundary.

Containerization is therefore part of the product's user value, not only an implementation technique. Users rely on it to try untrusted or immature code, reproduce an agent environment, remove that environment, and retain only the workspace data that Ploinky explicitly treats as durable.

### Standard agent structure

Every Ploinky agent must be described by a standard manifest and an agent-owned source directory. The manifest declares the runtime image, lifecycle commands, environment requirements, dependencies, startup behavior, communication surfaces, and other supported runtime options. Ploinky must interpret those declarations generically and must not require agent-specific branches in its core lifecycle or routing code.

The standard structure must make agents portable between compatible Ploinky workspaces and understandable to both people and tooling. An agent author must be able to determine how an agent starts, what it requires, what it exposes, and how persistent data is handled without relying on undocumented machine configuration.

### Controllable and observable execution

Users must be able to enable, start, restart, stop, disable, and remove agent runtime state through Ploinky-owned lifecycle commands. These actions must target the selected workspace and the exact agent instance, including aliased instances when the same agent is enabled more than once.

Ploinky must expose status, readiness, health, and logs that allow a user to determine whether the outer Box, Router, and agent runtimes are available and why a startup or runtime operation failed. Observation commands must not silently create, repair, or replace runtime state merely because the user requested diagnostic information.

### Communication with users, agents, and systems

An agent must be able to expose one or more supported communication interfaces while its process remains inside the isolated runtime. The standard agent CLI uses terminal input and output and can be presented directly in a shell or through WebChat. Agents may expose MCP tools, resources, and prompts through the private AgentServer surface, and may expose declared HTTP or compatible application interfaces through Ploinky-owned routing.

Ploinky must mediate communication between users, agents, and external systems through authenticated and policy-controlled interfaces. An agent must not need a directly published host port to participate in a multi-agent workspace, and one agent's identity or credentials must not authorize another agent.

### Git repository model

Ploinky must work with Git repositories as the distribution and development unit for agents. A repository may contain multiple agents, with each agent represented by its own directory and manifest. Users must be able to install or select a repository, discover its agents, enable a repository-qualified agent, and update the repository while keeping workspace runtime state separate from the checkout.

This model must support repositories that group related agents without coupling their runtime identities. Enabling one agent selects one declared agent environment; it does not make every agent in the same repository part of the active workspace unless manifests or user commands explicitly request them.

### Product boundary

Ploinky is responsible for standardized packaging, isolation, lifecycle control, observation, dependency preparation, and mediated communication. It is not responsible for deciding what an agent should do, which optional model or provider it should use, or whether third-party code is intrinsically trustworthy. Its responsibility is to run that code within the declared and enforced boundary and to give the user clear control over the resulting environment.
