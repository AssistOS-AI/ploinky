---
id: DS006
title: Auth, SSO Provider Selection, and Secure Wire
status: implemented (wire protocol superseded by DS011)
owner: ploinky-team
summary: Defines local auth, SSO provider selection, and the signed secure-wire path for delegated agent calls.
---

# DS006 Auth, SSO Provider Selection, and Secure Wire

## Introduction

Authentication and inter-agent trust in Ploinky are manifest-driven and workspace-scoped. This document defines the current model for local auth, SSO provider selection, and signed delegated invocations.

## Core Content

The router authentication layer must normalize successful authentication onto request context so that protected handlers can rely on `req.user`, `req.session`, and `req.authMode` rather than on transport-specific details. Token-based surface login remains valid for first-party browser surfaces when SSO is not active. Local auth must validate hashed credentials stored in a workspace-managed variable, while SSO must use the provider agent stored in workspace SSO config. Installed SSO providers advertise themselves with a top-level manifest marker: `ssoProvider: true`.

Local auth users must be stored as hashed user records rather than plain-text credentials. Session state must be retained in the router-side session store, and local-auth credential rotation must revoke sessions tied to the affected policy variable.

Agent discovery must be built from installed manifests. The agent index records installed agent references, deterministic principals, runtime resources, and SSO-provider markers. Provider-specific permissions are enforced by the target agent rather than by workspace-level provider negotiation.

Secure delegated tool calls must use router-minted invocation JWTs. The router signs tokens with `PLOINKY_DERIVED_MASTER_KEY` (the `derived-master` HKDF subkey). Invocation tokens bind the target audience, tool name, body hash, scopes, delegated user claims, and expiry. Agents verify tokens through `Agent/lib/invocationAuth.mjs` using the same derived key injected as `PLOINKY_DERIVED_MASTER_KEY`. The `/agent-card` and `/v1/chat/completions/<agent>` routes no longer require delegated caller JWTs; they use standard router authentication (session cookie or API key) and forward identity through `x-ploinky-auth-info`.

Secure wire is enabled by default and is only disabled when `PLOINKY_SECURE_WIRE` explicitly turns it off. This default matters because first-party calls and delegated calls share the same agent-side verification expectations once secure wire is active.

## Decisions & Questions

### Question #1: Why is the SSO provider a direct workspace setting?

Response:
The security model does not rely on generic provider declarations for SSO authorization. The router needs one configured provider agent that exports the SSO runtime functions, while the provider advertises discoverability through `ssoProvider: true`. Keeping this as direct workspace SSO config avoids maintaining broader provider-negotiation state that no longer gates security decisions.

### Question #2: Why does secure wire default to enabled?

Response:
The router proxy and agent runtime already implement invocation-token verification, caller-assertion verification, and replay caches as first-class features. Default-enabled secure wire makes the safer path the ordinary path and requires an explicit operator decision to disable verification when a legacy or diagnostic scenario needs it.

## Conclusion

Ploinky’s auth and trust model is workspace-scoped and invocation-token-backed. The repository must continue to document and implement local auth, direct SSO provider selection, and secure delegated invocations as connected parts of one system.
