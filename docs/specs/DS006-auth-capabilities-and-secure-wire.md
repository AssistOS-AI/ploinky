---
id: DS006
title: Auth, SSO Provider Selection, and Secure Wire
status: implemented (wire protocol superseded by DS011 and DS013)
owner: ploinky-team
summary: Defines SSO provider selection, guest/session handling, and the signed secure-wire path for delegated agent calls.
---

# DS006 Auth, SSO Provider Selection, and Secure Wire

## Introduction

Authentication and inter-agent trust in Ploinky are manifest-driven and workspace-scoped. This document defines the current model for SSO provider selection, guest/session handling, and signed delegated invocations.

## Core Content

The router authentication layer must normalize successful authentication onto request context so that protected handlers can rely on `req.user`, `req.session`, and `req.authMode` rather than on transport-specific details. Token-based surface login remains valid for first-party browser surfaces where still supported by the surface. Built-in local password login has been removed; SSO must use the provider agent stored in workspace SSO config. Installed SSO providers advertise themselves with a top-level manifest marker: `ssoProvider: true`.

User records and password policy now belong to the configured SSO provider agent. Router-owned guest sessions remain scoped, signed, and revocable by the router.

Agent discovery must be built from installed manifests. The agent index records installed agent references, deterministic principals, runtime resources, and SSO-provider markers. Provider-specific permissions are enforced by the target agent rather than by workspace-level provider negotiation.

**The secure-wire portion of this section is superseded by DS013.** The original model used a single shared `PLOINKY_DERIVED_MASTER_KEY` to sign `typ:"invocation"` tokens binding audience, tool, body hash, scopes, and user claims. That is replaced by per-agent secrets and three direction-typed, request-bound JWT families: the router mints a Router Request signed with the TARGET agent's own `PLOINKY_AGENT_SECRET`, and agent-to-agent calls present an Agent Assertion the source agent signs with its own secret. Agents verify through `Agent/lib/invocationAuth.mjs` using only their own `PLOINKY_AGENT_SECRET`. The `/agent-card` and `/<agent>/v1/chat/completions` routes are public at the router level; the target agent handles its own access control, and `/v1/chat/completions` never receives implicit `admin`/`internal` tool access. See DS013 (JWT families) and DS014 (MCP tool policy).

Secure wire is enabled by default and is only disabled when `PLOINKY_SECURE_WIRE` explicitly turns it off. This default matters because first-party calls and delegated calls share the same agent-side verification expectations once secure wire is active.

## Decisions & Questions

### Question #1: Why is the SSO provider a direct workspace setting?

Response:
The security model does not rely on generic provider declarations for SSO authorization. The router needs one configured provider agent that exports the SSO runtime functions, while the provider advertises discoverability through `ssoProvider: true`. Keeping this as direct workspace SSO config avoids maintaining broader provider-negotiation state that no longer gates security decisions.

### Question #2: Why does secure wire default to enabled?

Response:
The router proxy and agent runtime already implement invocation-token verification, caller-assertion verification, and replay caches as first-class features. Default-enabled secure wire makes the safer path the ordinary path and requires an explicit operator decision to disable verification when a legacy or diagnostic scenario needs it.

## Conclusion

Ploinky’s auth and trust model is workspace-scoped and invocation-token-backed. The repository must continue to document and implement direct SSO provider selection, guest/session handling, and secure delegated invocations as connected parts of one system.
