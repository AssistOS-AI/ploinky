# Claude Code Review Prompt: HTTP-Service RCH Body Hash

You are reviewing uncommitted changes in:

```text
/Users/danielsava/work/file-parser/ploinky
```

Please perform a code-review pass for M1: HTTP-service Router Request `rch` previously omitted the forwarded request body hash.

Read this handoff first:

```text
docs/plans/http-service-rch-body-hash-review-handoff.md
```

Then review the relevant uncommitted changes, primarily:

```text
Agent/lib/requestHash.mjs
Agent/lib/invocationAuth.mjs
cli/server/routerHandlers.js
tests/unit/httpServiceInvocation.test.mjs
tests/unit/invocationAuth.test.mjs
docs/specs/DS005-routing-and-web-surfaces.md
docs/specs/DS011-security-model.md
docs/specs/DS013-per-agent-identity-and-request-signed-jwts.md
docs/interfaces.html
```

Use a strict review stance. Do not implement fixes unless explicitly asked. Lead with findings ordered by severity, with file/line references. If there are no findings, say that clearly and call out residual risks or test gaps.

Review goal:

Verify that protected/guest HTTP-service invocation tokens are bound to the exact HTTP request body bytes and rewritten internal path that the router forwards upstream, and that downstream services have a standard verifier that rejects changed bodies, changed paths, and replay before trusting `x-ploinky-auth-info`.

Specific things to check:

| Area | Review question |
| --- | --- |
| Router signing | Does `handleHttpServiceRoute()` buffer only routes that need invocation minting, compute `bodyHash` from the exact bytes, sign `computeRchHttp({method,path,query,bodyHash})` with the rewritten internal service path, and forward the same bytes? |
| Shared hashing | Do router-side minting and service-side verification use the same raw-body-hash implementation from `Agent/lib/requestHash.mjs`? |
| Header handling | Are caller-supplied Ploinky identity headers stripped? Are `content-length` and `transfer-encoding` handled safely after buffering? |
| Invocation body | Does `x-ploinky-auth-info.invocationBody` carry method, signed internal path, external path as context, search string, route key, and body hash? |
| Verifier helper | Does `verifyHttpServiceAuthInfoFromHeaders()` parse the header, recompute the body hash from the received body, verify method/internal-path/query/body hash, and then verify the embedded Router Request token with tool `__http_service__` and replay protection? |
| Path contract | Does the router sign the internal path the service actually receives, and do tests reject the external path for rewritten services? |
| Payload limits | Does protected/guest invocation minting enforce `PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES` (default 10 MiB) and return 413 before proxying an oversized body? |
| 413 delivery | Does a real HTTP client receive the oversized-body 413 instead of the router resetting or hanging the socket? |
| Tests | Would the tests fail if `bodyHash` or internal `path` were omitted from the signed `rch`, omitted from `invocationBody`, or not checked by the downstream verifier? |
| Docs | Do DS005, DS011, DS013, and `docs/interfaces.html` match the implemented contract? |

Run these checks if the local environment permits:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/httpServiceInvocation.test.mjs tests/unit/requestHash.test.mjs tests/unit/routerRequestJwt.test.mjs tests/unit/invocationAuth.test.mjs tests/unit/httpRouteWhitelist.test.mjs tests/unit/agentApiRouting.test.mjs tests/unit/internalAgentPath.test.mjs tests/unit/agentAssertion.test.mjs tests/unit/agentEnvInjection.test.mjs tests/unit/mcpToolPolicy.test.mjs
git diff --check
```

For docs:

```bash
cd /Users/danielsava/work/file-parser/ploinky
tmpdir=$(mktemp -d /tmp/verify_static_site.XXXXXX)
tmp="$tmpdir/verify_static_site.cjs"
cp .agents/skills/gamp-specs/scripts/verify_static_site.js "$tmp"
node "$tmp" docs --path /interfaces.html --path '/specsLoader.html?spec=DS013-per-agent-identity-and-request-signed-jwts.md' --expect /interfaces.html='Router Request JWTs'
rc=$?
rm -rf "$tmpdir"
exit $rc
```

When reporting, include:

| Section | Content |
| --- | --- |
| Findings | Bugs, security gaps, regressions, missing tests, or doc/implementation mismatches, ordered by severity. |
| Open questions | Only questions that materially affect correctness. |
| Verification | Exact commands run and pass/fail output summary. |
| Residual risk | Anything acceptable but worth tracking, such as full-body buffering. |

Do not stage, commit, or rewrite unrelated worktree changes.
