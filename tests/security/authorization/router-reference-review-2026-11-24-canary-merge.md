# Router source reference review for the canary merge, 2026-11-24

The merge of `origin/master` (`8676e8e4`) into `agent-canary-int` (`c0223afc`) retains the blob registrations from both parents. Four merged files add registrations. Each carries every row, statement and anchor from the last canary-branch registration to the merged source line. The baseline, candidate and canonical entries match both parents.

This record is not a substitute for a security review.

| File under `cli/server/` | Last reviewed (canary / master) | Registered now | Rows moved from canary |
| --- | --- | --- | --- |
| `RoutingServer.js` | `57cff3f5` / `8a4be1c5` | `ea829d41` | All 23, by 4 to 19 lines. The two root rows move from 835 to 843 |
| `authHandlers/marketplaceRoutes.js` | `68c76924` / `caca9686` | `3bafeb6b` | All six, by 9 lines |
| `static/index.js` | `92005353` / `647fc532` | `e8d95589` | All six. Web libraries and workspace files move by 1 line, agent static by 2 |
| `edgeRoutePlan.js` | `5ad000ec` / `62537426` | `ced0b54d` | All five. Additional HTTP moves from 217 to 228 and the four private rows move by 29 lines |

- `RoutingServer.js` combines post-authentication canary selection and the dial-time recheck with the early CDN response hook, the cache response arguments, and CDN `no-store` on raw WebSocket refusals. The private listener dispatches the cache operation and the static root redirect resolves the browser entry path. The `agent-openai.post` row follows the branch's shared dispatch condition, which covers the canary and ordinary handlers.
- `authHandlers/marketplaceRoutes.js` retains canary filtering for enabled-agent and no-wait listings and the administrator and Origin/CSRF guards for the cache operation.
- `static/index.js` retains the pre-serve selection check and confined export reads for canary assets, alongside the CDN cache mark for public web libraries.
- `edgeRoutePlan.js` retains canary admission and runtime selection alongside ingress cache response fields for agent-port and active agent-root plans, including a root plan awaiting post-authentication target selection. The private listener still resolves the exact `POST /api/edge/cache` operation.

The Live Sessions overlay retains both parents' `handlers/webtty.js` pin (`08ce7191`) and all five source lines. Its merged notes describe controller access on shared CLI terminals, recovery claims scoped to the attaching principal, and the shared size-holder rule.

The canary status overlay in `router-inventory.mjs` pins the merged `RoutingServer.js` blob. Its existing `canary-status.get` condition moves from line 467 to 471.
