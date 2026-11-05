# Router source reference review, 2026-11-05

Reviewer scope: a registry addition to `router-reference-obligations.json` for the root-application startup probe. Registry changes are additions only: one new blob, and every existing blob and every `baseline`/`canonical` row is unchanged.

This record is not a substitute for a security review of the change. A reviewer must still read the candidate diff and confirm or refuse it.

## Blob hashes

| File | Last reviewed | Registered now |
| --- | --- | --- |
| edgeRoutePlan.js | 68cb2543 | e1a96459 (a probe branch before the root application fallthrough, one late import, and one helper at the end of the file) |

## edgeRoutePlan.js (blob e1a96459)

The five registered rows keep their lines (196, 808, 826, 844, 865) because every insertion comes after line 865.

On a host with a root application, an unclaimed path normally goes to that application. The new branch keeps a request from it only when all of these hold:

| Condition | Enforced by |
| --- | --- |
| The path is exactly `/<routeKey>/`, with one percent-decode of the segment, and the route key is in the host's MCP-admitted routes, including the Marketplace extension | `selectedStartupProbeRoute` |
| The request is an HTTP GET with `X-Ploinky-Agent-Startup-Probe: 1` and no bearer authorization | `classifyAgentStartupRequest`, the same classifier the startup slot uses |

The plan keeps the owner as its selected root, so its decision, target and upstream path match a host without a root application. `dispatchAgentStartupRequest` authorizes that decision and answers from the Router. The classifier check means no plan reaches this branch's return unless the startup slot will consume it, so the branch cannot dial an agent. Every other request still reaches `agentPortPlan` unchanged.

After the owner's normal authorization, the response body carries only the probe fields already returned on hosts without a root application.
