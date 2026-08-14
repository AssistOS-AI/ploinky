---
title: DS007-auth-capabilities-and-secure-wire
summary: Defines local, SSO, and guest authentication, administrative authority, delegated calls, and capability boundaries.
---

# DS007 Authentication, Capabilities, and Secure Wire

## Introduction

Ploinky separates human sessions, guest identity, administrative authority, agent identity, and runtime placement capability. Possession of one class must not imply another.

## Core Content

Local authentication must verify credentials from the encrypted workspace password store and mint a bounded Router user session. SSO must use a manifest-selected provider, short-lived pending state, validated callback state, and a server-side normalized session. Guest access must be explicitly selected by route policy or manifest service policy, must use a bounded route-scoped guest identity, and must never provide administrative or internal-agent authority.

Administrative TCP operations require an authenticated local administrator. SSO users, ordinary local users, guests, Agent Assertions, Router Requests, delegation grants, LiveKit tokens, network provenance, and host-mode capability are not administrative credentials. State-changing browser requests must also satisfy Origin and CSRF or equivalent mutation-proof validation.

The Router must authenticate agent-to-agent and delegated calls through request-bound token families defined by DS014. A source agent may assert only its own exact principal, instance, and enable generation. The Router must verify that assertion, apply route and MCP policy plus any exact caller ACL, and mint a target-scoped Router Request. Human identity may be carried only through a separately validated delegation grant; an Agent Assertion alone carries no human identity or consent.

Runtime capability grants authorize only the exact placement or resource operation for the current generation. Host networking, private relay setup, runtime replacement, and protected listener access must require an exact non-replayable capability and must revalidate it immediately before the privileged boundary action. A capability does not authorize application requests.

Authentication failure must be indistinguishable from unavailable private state wherever revealing the distinction would disclose a protected target. Tokens and session material must not enter logs, persisted routing state, evidence artifacts, URLs, or browser-visible payloads except where the protocol explicitly requires an opaque short-lived credential.

## Conclusion

Ploinky must preserve separate proofs for user identity, guest scope, administration, agent origin, delegated consent, and runtime capability through every mediated request.
