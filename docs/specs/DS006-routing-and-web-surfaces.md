---
title: DS006-routing-and-web-surfaces
summary: Defines Router listener separation, host-first route selection, mediated agent proxying, browser surfaces, WebChat, and Marketplace behavior.
---

# DS006 Routing and Web Surfaces

## Introduction

The Router is the only Ploinky-owned network mediator between users, applications, and enabled agents. It must select a closed surface from listener class and exact Host before it considers a pathname.

## Core Content

The public/control listener uses in-Box TCP port `8080`; the private managed-agent listener uses `8081` and must not be published outside the Box. Detailed supervisor health belongs on a private Unix socket. Listener reachability, loopback origin, and host-gateway transport are not authorization and must never replace route policy or request credentials.

Each request must resolve against the active immutable route generation and an exact agent instance and enable generation. Transparent agent proxying must strip the `/<agent>` prefix only after admission, preserve the validated query and request semantics, remove caller-supplied Ploinky identity headers, and regenerate trusted identity context only after authentication and policy succeed. HTTP, SSE, and WebSocket flows must apply equivalent admission, lease revalidation, header sanitation, size limits, and upstream target confinement.

Router-owned paths include authentication, selected-root user administration, policy commands, Marketplace, metrics, WebChat, workspace-file access, and other explicitly registered control surfaces. They must not become agent routes or be made reachable by a broad wildcard. Agent-owned static pages, APIs, MCP endpoints, OpenAI-compatible endpoints, and declared HTTP services remain behind the Router and are confined to the active target recorded for that agent.

WebChat must remain a generic transport for one selected enabled agent. It may provide authenticated terminal streaming, structured message envelopes, task and session views, interaction prompts, skills controls, workspace path suggestions, bounded uploads, and workspace-file previews. Core code must not hardcode optional agent ids, provider tags, downstream tool names, or domain-specific dispatch. State-changing browser requests must carry the Router's mutation proof and must remain bound to the active user session and selected workspace runtime.

The Router-owned Marketplace read surface may expose caller-appropriate repository and agent inventory to authenticated users. Marketplace mutations require local administrative authority, except that a running agent may use a request-bound Agent Assertion for the explicitly allowlisted read and enable-agent operations. Agent callers must not gain browser administration, repository installation or removal, agent disablement, or other mutation authority through that path.

The Router must return generic errors to unauthenticated or guest callers and must not reveal whether a private target exists. A missing host, route, policy, target, active generation, or valid lease must fail closed.

## Conclusion

Every Ploinky user surface must converge on the same Router-owned workspace, route generation, authentication context, and exact private target without exposing agent listeners directly.
