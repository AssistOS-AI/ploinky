# Router source reference review, 2026-11-24

Reviewer scope: registry additions to `router-reference-obligations.json` for Router source that changed after the last registration, and a re-pin of the Live Sessions overlay in `router-live-sessions-inventory.mjs`. Registry changes are additions only: new blobs, and every existing blob and every `baseline`/`candidate`/`canonical` entry is unchanged. Each new blob carries every row of the previous reviewed blob to its shifted line; no registered statement or anchor changed.

This record is not a substitute for a security review of the change. A reviewer must still read the candidate diff and confirm or refuse it.

## Master drift

On master at `9632872b`, `router-source-drift.test.mjs` reported 37 mismatches in four files that five commits had changed without registering. These blobs match master's bytes, so the Router source in `origin/master` (`f015af60`) also resolves with no drift.

| File | Last reviewed | Registered now | Commits |
| --- | --- | --- | --- |
| handlers/webtty.js | c048c0fc | 08ce7191 | `0839c1d9` (2026-11-20) |
| handlers/webchat/index.js | bd69996d | 8421568f | `02d64bde` (2026-11-04) |
| handlers/blobs.js | 4fdb5efc | 87202bbb | `dc02417c` (2026-11-16) |
| authHandlers/marketplaceRoutes.js | 40669dc5 | c21698e4 | `f54a65ad` (2026-10-30), `02d64bde` (2026-11-04), `bd29e863` (2026-11-05) |

### handlers/webtty.js (blob 08ce7191)

The resize branch now accepts `{cols, rows}` plus an optional `claim`, which must be exactly `true`, and an optional `view`, which must match the view-id pattern. Any other key is refused with 400. It still runs `verifyMutationBeforeBody` before reading the body and `manager.authorize(..., 'resize')` and `commitMutation` before acting, then calls `manager.requestResize` instead of `manager.resize`. Only `webtty-delete.delete` moved (503 to 517).

The Live Sessions overlay pins this blob now. Its close-intents and close-policy additions moved from 490 and 496 to 504 and 510; the other three additions keep 218, 251 and 255.

The same commit changed who controls a shell, in `cli/server/webtty/sessionManager.mjs`, which the registry does not cover. A shell opened by the signed local CLI operator (`local:admin` on the `cli` channel) is shared: `controls()` treats every administrator on the same host-route as its owner. That applies to input, resize, close policy, close intents, recovery claims and attach. `authorize()` still validates an administrator lease before the `controls()` check, so the role expectations (administrator only) are unchanged. The overlay notes that said "owner principal only" or "other administrators cannot type" now state the shared-shell exception, and the resize note names the new body and the size-holder rule.

### handlers/webchat/index.js (blob 8421568f)

The WebChat page template gains `__AUTH_ROUTE_KEY__`: the HTML-escaped route key of the request's auth context, or an empty string on a host bound to one route. It is an output value only; no row moved and no gate changed.

### handlers/blobs.js (blob 87202bbb)

Agent blob storage moved from `.data/<agent>/blobs` to `.data/agents/<agent>/blobs`, in the upload path and in the reported local path. The agent key is still validated by `validateAgentDataKey`. No row moved and no gate changed.

### authHandlers/marketplaceRoutes.js (blob c21698e4)

| Row | Line |
| --- | --- |
| marketplace-agents-read.get | 907 to 966 |
| marketplace-repos-read.get | 937 to 996 |
| marketplace-install_repo.post, marketplace-uninstall_repo.post | 1010 to 1083 |
| marketplace-enable_agent.post | 1036 to 1109 |
| marketplace-disable_agent.post | 1038 to 1133 |

Two request surfaces are new. Neither has its own inventory row.

| Surface | Gate |
| --- | --- |
| `GET /api/marketplace/agents?operation=<id>` | `ensureAdmin` before any read, then exactly one well-formed id, then a lookup scoped to the caller's auth mode, user id, origin and host route. It is stricter than its row `marketplace-agents-read.get`, whose policy is `session` |
| `POST /api/marketplace/agents` `enable_agent` with `Prefer: respond-async`, browser callers only | Runs after the unchanged POST gates (administrator, exact Origin and CSRF, then the body, then the lease commit). It answers 202 with an operation id, or 429 when the bounded queue is full, and the background job keeps only the admitted lease, not the request |

The other changes are error messages (a recovery instruction after a timed-out or failed worker) and the repository kind, which now comes from `resolveRepoKind`.
