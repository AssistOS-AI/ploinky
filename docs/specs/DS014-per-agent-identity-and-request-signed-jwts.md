---
title: DS014-per-agent-identity-and-request-signed-jwts
summary: Defines per-agent secrets, exact runtime tuples, direction-typed request tokens, delegation grants, replay protection, and confined relay credentials.
---

# DS014 Per-Agent Identity and Request-Signed JWTs

## Introduction

Ploinky must give every enabled agent a distinct principal and must bind executable authorization to one request and one active runtime generation. Shared reusable invocation keys are prohibited.

## Core Content

The canonical agent principal is `agent:<repo>/<agent>`. Each enabled record must also carry a random instance id and enable generation. Replacement, disable and re-enable, or another identity-changing operation must rotate the tuple so a predecessor cannot act as its successor.

Ploinky must derive each credential-capable agent's request secret from the workspace master and canonical principal. The launcher may inject only that agent's secret after Router authority, immutable runtime ownership, exact generation, and generated-local descriptor are attested inside the launch transaction. Other runtimes receive principal and tuple metadata but no reusable Router-facing secret.

Agent Assertions prove that one exact source tuple originated a request. Router Requests prove that the trusted Router authorized one exact target operation. User delegation grants carry separately authenticated human identity and constrained consent. These token families must use distinct types, issuers, audiences, keys, claims, and verification paths and must not be accepted as user sessions, administrative credentials, LiveKit credentials, or one another.

Every executable token must bind the applicable method, normalized path, query, tool, arguments, and body hash through a canonical request-content hash. Verification must enforce issuer, audience, type, subject, source and target tuple, active generation, expiry, nonce or token id, content hash, exact operation, policy, and replay state. A token valid for one route, tool, method, body, or generation must not be reusable for another.

Agent-to-agent flow must verify the source Agent Assertion and caller ACL, apply MCP or HTTP policy, then mint a target-scoped Router Request. Delegated human flow must additionally verify the user grant and preserve its scope. The target agent must verify the Router Request using only its own secret and must not trust caller-supplied identity headers.

Confined access to a host-networked loopback service must use a fresh generation-bound relay channel credential delivered through the private channel only after exact container and lease verification. The credential must not be persisted, logged, copied to ordinary environment state, or usable outside that channel.

## Conclusion

Per-agent derivation and request binding must ensure that compromising one agent cannot forge another agent's identity and that stale or replayed authorization cannot cross a runtime generation.
