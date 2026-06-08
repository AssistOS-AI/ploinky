# Handoff: HTTP-Service RCH Body Hash Review

## Purpose

This handoff is for reviewing the fix for M1: HTTP-service Router Request `rch` previously omitted the forwarded HTTP request body hash.

`rch` means request-content hash. For HTTP service invocation tokens, the intended signed surface is:

```js
computeRchHttp({ method, path, query, bodyHash })
```

where `bodyHash` is `base64url(sha256(rawForwardedBodyBytes))`.

## What Changed

The change makes HTTP-service invocation signing two-sided:

| Side | Change |
| --- | --- |
| Router mint/forward side | Protected or guest HTTP-service routes that mint an invocation token now buffer the incoming request body up to `PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES` (default 10 MiB), hash the exact bytes through the shared `sha256RawBodyHash()` helper, include `bodyHash` in `x-ploinky-auth-info.invocationBody`, sign `rch` with `computeRchHttp`, and forward the same buffered bytes upstream. |
| Path binding | `invocationBody.path` and the Router Request `path` claim are the rewritten internal path the service receives. `invocationBody.externalPath` remains route context only. |
| Service verify side | `Agent/lib/invocationAuth.mjs` now exports `verifyHttpServiceAuthInfoFromHeaders()`, which parses the `x-ploinky-auth-info` carrier, recomputes the received body hash, verifies method/internal-path/query/body hash against `invocationBody`, then verifies the embedded Router Request token with replay protection by default. |
| Tests | Added regression coverage for body-bound router minting, internal-path binding, oversized body rejection on mock and real sockets, guest actor kind, default replay rejection, and service-side rejection of a changed body. |
| Specs/docs | DS005, DS011, DS013, and `docs/interfaces.html` now describe body-bound HTTP-service invocation tokens and the service verifier. |

## Primary Files To Review

| File | Why it matters |
| --- | --- |
| `Agent/lib/requestHash.mjs` | Shared request-content-hash and raw-body-hash implementation used by both router and agent-side verification. |
| `cli/server/routerHandlers.js` | Router-side HTTP-service body buffering, `bodyHash` computation, `computeRchHttp` signing, and buffered proxying. |
| `Agent/lib/invocationAuth.mjs` | Agent/service-side verifier for the `x-ploinky-auth-info` HTTP-service carrier. |
| `tests/unit/httpServiceInvocation.test.mjs` | Regression proving the router signs the real forwarded body and rejects a tampered body hash during token verification. |
| `tests/unit/invocationAuth.test.mjs` | Regression proving the service helper accepts the real body and rejects a changed body. |
| `docs/specs/DS005-routing-and-web-surfaces.md` | Router HTTP-service contract. |
| `docs/specs/DS011-security-model.md` | Security model for downstream services trusting router SSO only after token verification. |
| `docs/specs/DS013-per-agent-identity-and-request-signed-jwts.md` | Canonical per-agent Router Request / request-content-hash spec. This file may be untracked in the current worktree because it was introduced by the broader DS013 work. |
| `docs/interfaces.html` | Human-facing docs summary. |

## Review Focus

Check these points carefully:

| Area | Questions |
| --- | --- |
| Exact byte binding | Does the router hash exactly the bytes it forwards upstream, including empty bodies? |
| Header correctness | Does buffered proxying strip caller-supplied Ploinky identity headers, remove stale `content-length` / `transfer-encoding`, and set the new `content-length` correctly? |
| Token surface | Does the token bind method, rewritten internal path, query string, tool `__http_service__`, and `bodyHash`, while preserving `externalPath` only as context? |
| Receive-side verifier | Does `verifyHttpServiceAuthInfoFromHeaders()` verify the header carrier before returning `authInfo` and reject method/path/query/body mismatches? |
| Path semantics | Does a service verify using the internal path it actually receives, not by reflecting `externalPath` from the header? |
| Memory behavior | Protected/guest HTTP-service invocation routes buffer only up to the configured limit and return `413 http_service_body_too_large` before proxying an oversized body. |
| Failure modes | A missing invocation principal should fail closed before proxying identity metadata; request read errors should not leave the response hanging. |
| Regression strength | Tests should fail if `bodyHash` or internal `path` is removed from `invocationBody`, omitted from `computeRchHttp`, or not compared on the service side. |

## Verification Already Run

From `/Users/danielsava/work/file-parser/ploinky`:

```bash
node --test tests/unit/httpServiceInvocation.test.mjs tests/unit/requestHash.test.mjs tests/unit/routerRequestJwt.test.mjs tests/unit/invocationAuth.test.mjs tests/unit/httpRouteWhitelist.test.mjs tests/unit/agentApiRouting.test.mjs tests/unit/internalAgentPath.test.mjs tests/unit/agentAssertion.test.mjs tests/unit/agentEnvInjection.test.mjs tests/unit/mcpToolPolicy.test.mjs
```

Result: 79 tests, 79 pass.

```bash
git diff --check
```

Result: clean.

```bash
tmpdir=$(mktemp -d /tmp/verify_static_site.XXXXXX)
tmp="$tmpdir/verify_static_site.cjs"
cp .agents/skills/gamp-specs/scripts/verify_static_site.js "$tmp"
node "$tmp" docs --path /interfaces.html --path '/specsLoader.html?spec=DS013-per-agent-identity-and-request-signed-jwts.md' --expect /interfaces.html='Router Request JWTs'
rc=$?
rm -rf "$tmpdir"
exit $rc
```

Result: OK for `/interfaces.html` and DS013.

## Worktree Notes

The worktree contains many broader uncommitted security changes unrelated to M1. Do not assume every dirty file belongs to this fix. For M1, focus on the files listed above and compare the relevant hunks rather than trying to review the entire security branch as one change.

No files were staged or committed as part of this handoff.
