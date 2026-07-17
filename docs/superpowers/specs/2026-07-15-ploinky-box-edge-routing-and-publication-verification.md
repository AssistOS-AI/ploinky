# Ploinky Box Edge Routing and Publication — Implementation Verification

Date: 2026-07-15

Status: **NOT RELEASE-READY**. The fixed outer publication boundary passed
authoritative engine inspection, but the fresh full Explorer graph failed
closed at the approved private-Router listener contract. The two-account
screen-share and native cross-network media gates therefore remain blocked and
have not been weakened, skipped, or claimed as passes.

Authority: [2026-07-15-ploinky-box-edge-routing-and-publication-design.md](./2026-07-15-ploinky-box-edge-routing-and-publication-design.md), especially section 17.

## 1. Scope and revisions

Implementation was performed in the existing dirty checkout without committing,
pushing, deploying, or changing Cloudflare, DNS, TURN, or other production
resources. The pre-existing untracked design/review evidence was preserved.

| Repository | Inspected HEAD | Implemented slice |
| --- | --- | --- |
| `ploinky` | `ffc6487d5a3ba55aaa6af0a06e14f78bc086350c` | Runtime contract v5 and fixed publications; hard-cut deletion; immutable route/policy generations; host-first HTTP/SSE/WS routing; private Router and assertions; topology; Cloudflare publication controller; listener profiles; smoke and normative documentation. |
| `container-image-builds` | `4133cb9b26cec600809191cadac41f19284fe3dc` | Pinned box-owned cloudflared integration, pinned agent images, loopback Egress image, supply-chain/source-absence checks, and retired standalone publication images/workflows. |
| `AssistOSExplorer` | `a11271a77d3f9d69de02f3a0d5d57e20ddc4c694` | Slim service manifests, topology consumers, private LiveKit calls, credential refresh/rejoin, OnlyOffice split surfaces and drain/persistence security, real Umami/GPTResearcher browser gates, and the bidirectional screen-share/network release automation. |
| `webmeetInfra` | `c43d2ac396af0f500c422fd1777a7095a6412d6f` | Literal LiveKit media config, host capability, loopback signaling, external TURN, distinct Egress listeners and semantic probes. |
| `UmamiAgent` | `7848e111430a92a4584e28a954ea6fe5de0638eb` | Authenticated dashboard, narrow credential-stripping telemetry proxy on `3001`, private MCP bind, base-path behavior, and abuse controls. |
| `AchillesCLI` | `6dfa02c3290d9e9a79cf3836be5f9c550acd9d48` | Immutable GPTResearcher inputs, base-path adapter, slim explicit-port manifest, reproducibility and routing tests. |
| `proxies` | `a25015d97d756aaad050faa46273a929f25222ce` | Retired publication deployment inputs and source-absence enforcement. |
| `basic` | `c501b2db5000f5fb88f36ca6f1f1b9c661b5ec42` | Complete executable/config/test/normative removal of `cloudflared` and `web-publishing`; WebTTY retained behind Router. |

## 2. Reachable verification results

`PASS` means the command completed successfully. `FAIL` means a reachable
assertion failed. `BLOCKED` means the uncompromised gate could not execute
because an explicitly required external or topology prerequisite was absent.

| Result | Working directory and exact command | Result |
| --- | --- | --- |
| PASS | `ploinky`: `node --test tests/unit/startupConfigProviders.test.mjs tests/unit/workspaceDependencyGraph.test.mjs tests/unit/lifecycleHostHookEnv.test.mjs` | 54 passed, 0 failed/skipped. |
| PASS | `ploinky`: `node --test tests/unit/cloudflarePublicationRuntime.test.mjs tests/unit/policyStateRepository.test.mjs tests/unit/edgeGenerationHardCut.test.mjs` | 60 passed, 0 failed/skipped. |
| PASS | `ploinky`: `node --test container/runtime-supervisor-tests.mjs container/listener-inventory-tests.mjs` | 163 passed, 0 failed/skipped. |
| PASS | `ploinky`: changed/new `Agent`, `cli`, and `container` JavaScript enumerated from `git diff --name-only` plus `git ls-files --others --exclude-standard`, then `xargs -n 1 node --check` | 90 modules parsed. |
| FAIL | `ploinky`: `node --test tests/unit/*.test.*` | 1,453 total: 1,446 passed, 5 failed, 2 skipped. The five reproduced unchanged baseline failures are recorded in section 7. |
| PASS | Each affected repository's `*source-absence*.test.mjs` suite | 14 passed, 0 failed/skipped across all eight repositories. |
| PASS | `container-image-builds`: `node --test tests/*.test.mjs` | 21 passed. |
| PASS | `webmeetInfra`: `node --test liveKitServerAgent/tests/*.test.mjs` | 23 passed. |
| PASS | `UmamiAgent`: `node --test umamiAgent/tests/*.test.mjs` | 20 passed. |
| PASS | `proxies`: `node --test tests/*.test.mjs` | 12 passed. |
| PASS | `basic`: `node --test tests/unit/*.test.mjs` | 35 passed, 0 failed, 1 platform skip (`bwrap` unavailable). |
| PASS | `AchillesCLI`: `node --test GPTResearcher/test/*.test.mjs achilles-cli/tests/manifest-dependencies.test.mjs` | 26 passed. |
| PASS | `AchillesCLI/GPTResearcher`: `python3 test/test_base_path_adapter.py` | 4 passed. |
| PASS | `AssistOSExplorer`: `node --test onlyOffice/tests/*.test.mjs onlyOffice/tests/e2e/*.test.mjs` | 86 passed, 0 failed, 6 real-Router/browser skips; those external lanes are `BLOCKED`, not accepted as passed. |
| PASS | `AssistOSExplorer/webmeetAgent`: `node --test tests/unit/join-material-refresh.test.mjs tests/unit/livekit-private-route.test.mjs tests/unit/participant-identity-ownership.test.mjs tests/unit/rtc-config-ice-mitigation.test.mjs tests/unit/room-auth-contract.test.mjs tests/unit/webmeet-livekit-presence.test.mjs tests/unit/webmeet-store-remediation.test.mjs` | 36 passed. |
| FAIL | `AssistOSExplorer/webmeetAgent`: `set -o pipefail; node --test --test-reporter=tap tests/unit/*.test.mjs \| rg '^(not ok\|# tests \|# pass \|# fail \|# skipped \|# duration_ms)'` | 191 total: 184 passed, 7 failed, 0 skipped; independently reproduced broader-suite baseline failures are recorded in section 7. |
| PASS | `AssistOSExplorer/tests/smoke`: `find lib scripts specs -type f -name '*.mjs' -print0 \| xargs -0 -n1 node --check` | All smoke modules parsed. |
| PASS | `AssistOSExplorer/tests/smoke`: `npm run test:unit` | 34 passed, 0 failed/skipped. |
| PASS | All eight repositories: `git diff --check`; untracked files checked with `git diff --no-index --check /dev/null <file>` | No task-owned whitespace defects. The original review artifact's intentional Markdown hard breaks were preserved. |
| PASS | Documentation/matrix/source adversarial re-audit | 54 contiguous DS entries, 28 generated matrix entries matching metadata, no stale startup-order wording, and no retired active-source symbols. |

## 3. Primary exact-port boundary gate

The real-engine command used a newly built arm64 runtime-v5 image:

```sh
cd /Users/danielsava/work/file-parser/ploinky
SMOKE_IMAGE=localhost:5001/ploinky-box:v5-final \
SMOKE_PORT=18080 \
SMOKE_ROUTING_GRAPH_LISTENER_TIMEOUT_MS=30000 \
SMOKE_FULL_GRAPH_LISTENER_TIMEOUT_MS=180000 \
SMOKE_FULL_GRAPH_ARGS_JSON='["start","AssistOSExplorer/explorer","18080"]' \
SMOKE_FULL_GRAPH_REPOSITORIES_JSON='{"AchillesCLI":"/Users/danielsava/work/file-parser/AchillesCLI","AssistOSExplorer":"/Users/danielsava/work/file-parser/AssistOSExplorer","UmamiAgent":"/Users/danielsava/work/file-parser/UmamiAgent","basic":"/Users/danielsava/work/file-parser/basic","container-image-builds":"/Users/danielsava/work/file-parser/container-image-builds","proxies":"/Users/danielsava/work/file-parser/proxies","webmeetInfra":"/Users/danielsava/work/file-parser/webmeetInfra"}' \
SMOKE_EDGE_DESIRED_FILE=/tmp/ploinky-v5-full-graph-desired.json \
SMOKE_MEDIA_PUBLIC_IPV4=8.8.8.8 \
node container/smoke-runtime.mjs
```

Image evidence:

- image ID `sha256:ab37db5517957649a21df331283e6187230b4e8e75b6288ea44977dfa5e3e310`;
- created `2026-07-15T21:57:11.845465791Z`;
- runtime-contract label `5`;
- local manifest digest `sha256:846e07c4a6d14a9518b204fa361e9edd87feca5476ff7446cd9ff24e92b64d5f`;
- Linux `arm64` image built for this verification, not a mock backend.

After empty create, retained-state recreate, routing-probe start/removal, and full
Explorer start attempt, normalized `HostConfig.PortBindings` was identical:

```json
{
  "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}],
  "7882/udp": [{"HostIp": "0.0.0.0", "HostPort": "7882"}]
}
```

Normalized `podman port` contained exactly the same two records. Equality of the
complete engine structures proves there was no third publication and therefore
none of private Router `8081`, LiveKit `7880/7881`, ranges, local TURN, Egress,
OnlyOffice, Umami, GPTResearcher, databases, stable agent ports, or public
`80/443` were published.

Additional observed evidence:

- `http://127.0.0.1:18080` reached Router and returned `401`;
- the physical/LAN address `192.168.1.13:18080` refused connection;
- reserving `0.0.0.0:7882/udp` in the generated
  `ploinky-box-…-udp-conflict` container made create fail before creating the
  managed box, and the diagnostic identified that exact owner and the required
  stop/remove action;
- host inspection was supplemental only; the full `PortBindings`/`podman port`
  equality was authoritative.

### In-box listener evidence and failure

The routing-probe owner-aware `ss -H -lntup` inventory observed:

| Namespace | Socket | Owner | Result |
| --- | --- | --- | --- |
| outer | `0.0.0.0:8080/tcp` | `MainThread` (Node Router) | expected public listener |
| outer | `127.0.0.1:8081/tcp` | `MainThread` (Node Router) | expected private loopback listener |
| outer | `10.89.0.1:8081/tcp` | none | required managed-gateway bind missing |

The managed network advertised `10.89.0.0/24` with gateway `10.89.0.1`, but
that gateway was not assigned in the outer box namespace. Under the required
inner launch flags, rootless Podman resolved
`host.containers.internal:host-gateway` through `169.254.1.2`, not an address on
which the outer Router could satisfy the approved exact private-listener model.
The Router therefore threw `PRIVATE_LISTENER_SET_INCOMPLETE` instead of widening
the bind or adding an unauthorized forwarder. The full Explorer dependency graph
never launched; its full listener inventory was consequently empty, including
no LiveKit owner for `7882/udp`.

**Gate result: FAIL.** The exact physical publication subset passed every phase,
but section 17 requires the complete fresh graph and owner-aware private
inventory as part of this primary gate.

## 4. Primary two-account WebMeet screen-share gate

Exact required command:

```sh
cd /Users/danielsava/work/file-parser/AssistOSExplorer/tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_WEBMEET_MEDIA=1 \
SMOKE_WEBMEET_SCREEN=1 \
SMOKE_TEST_TIMEOUT_MS=240000 \
npm test -- --headed --project=chromium specs/30-webmeet-room-chat.spec.mjs
```

The retired-source precheck passed `1/1`; the command then exited `1` before
Playwright opened a browser because it found zero running exact runtime-v5 outer
containers with `127.0.0.1:8080:8080/tcp` and
`0.0.0.0:7882:7882/udp`. This is a hard preflight failure, not `test.skip`.

The implemented suite statically and unit-verifiably uses two isolated contexts,
requires distinct authenticated principals, activates the real
`#webmeetScreenShareButton`, checks local publication/UI state, remote
`screen_share` track attachment and readiness, screen-specific RTP growth,
teardown, the reverse direction, exact selected candidates, redacted diagnostics,
and cleanup. It does not mock `getDisplayMedia` or LiveKit.

**Gate result: BLOCKED.** Because no browser was started, there are no identities,
publication IDs, selected-candidate pairs, screen RTP counters, screenshots,
videos, or trace artifact paths to report. Claiming such evidence would be false.

## 5. Native network, TURN, Cloudflare, and browser gates

`AssistOSExplorer/tests/smoke` command
`npm run test:webmeet-network-matrix` exited `1` before external operations:

```text
The native WebMeet network matrix requires Linux amd64 or arm64; got darwin/arm64.
```

The available Podman server was Linux/arm64 Podman `5.8.2`, rootless Netavark
`1.17.2`, Aardvark DNS `1.17.0`, hosted by a Darwin/arm64 Podman machine. This is
not the native Linux host required to validate the physical-to-box UDP hop.

The following remained `BLOCKED` and unexecuted:

- native Linux amd64 and native Linux arm64 direct-UDP lanes with two browsers
  on distinct external networks and exact public IPv4 `:7882` candidate evidence;
- external TURN/UDP and TURN/TLS fallback lanes and credential-expiry rejoin;
- live Cloudflare existing-tunnel/DNS/ingress convergence and external probe;
- real-browser full-stack OnlyOffice, Umami, and GPTResearcher routing gates;
- the complete full-Explorer owner inventory and independent external port scan.

No test Cloudflare connector/API credentials, TURN URLs, network-scanner SSH/CDP
endpoints, two account credentials, public media IPv4, or external probe run id
were configured. `Xvfb` was also absent. No quick tunnel, new tunnel, DNS record,
TURN account, or production resource was created or changed.

## 6. Security and adversarial checks

- Coordinated apply rechecks exact generation before inactivation, after byte
  capture, and at commit; invalid/corrupt generations remain inactive.
- HTTP, SSE, and WebSocket dials share the immutable plan/policy lease and
  immediate pre-connect generation revalidation.
- The private executor composes effective authenticated policy with exact
  current-instance/current-enable-generation ACL and request-bound replay-safe
  assertions; assertions are not admin sessions.
- Complete engine bindings, source-absence suites, forbidden-symbol scans,
  manifest validation, host/interface/path partitions, header spoofing, admin
  Origin/CSRF, JWT, bounded fetch/callback, topology confidentiality, and
  redacted-artifact unit suites were exercised at their reachable layers.
- A real throwaway Playwright 1.60 trace proved the short credential was present
  before sanitization and absent after attachment. Structural `fill`, `type`,
  `pressSequentially`, and `insertText` values are propagated across all textual
  trace members; the short/default, one-character, Unicode, and 8,192-character
  adversarial cases passed, and residual generic input-action fields fail the
  attachment.
- An adversarial review found and fixed generation races, startup-order drift,
  stale identity reuse, network evidence trust boundaries, guest-principal
  admission, and Playwright trace credential-shape handling before this record
  was finalized.

## 7. Remaining failures and exact implementation blocker

The architecture-conflicting slice is stopped at the precise fail-closed point:

- `ploinky/cli/server/privateListenerSet.js:209` records the exact bind failure;
- `ploinky/cli/server/privateListenerSet.js:223` throws the strict aggregate
  `PRIVATE_LISTENER_SET_INCOMPLETE` error;
- `ploinky/docs/specs/DS004-runtime-execution-and-isolation.md:288` records the
  evidence and the three architecture choices requiring explicit approval;
- the authority's implementation note is at
  `2026-07-15-ploinky-box-edge-routing-and-publication-design.md:17`.

No silent redesign was made. Binding an outer-facing interface, adding a
forwarder, or changing the required host-gateway contract would amend the
approved security architecture.

The complete Ploinky unit suite also has five unchanged baseline failures:

1. `tests/unit/llmArchitectureCatalog.test.mjs:173` rejects sibling catalog
   `amd-rocm-amd64.json:20` (`seccomp=unconfined`).
2. `tests/unit/speechFeatureRemoval.test.mjs:156` references an absent historical
   `cli/server/webmeet/webmeet.html`.
3. `tests/unit/speechFeatureRemoval.test.mjs:200` references absent historical
   `docs/spec-webmeet.html`.
4. `tests/unit/webchatSuggestionsFiles.test.mjs:160` has a legacy cwd expectation.
5. `tests/unit/webchatSuggestionsFiles.test.mjs:183` has the paired legacy cwd
   expectation.

The complete WebMeet unit suite reproduces seven broader baseline failures:
automatic/manual audio processing, blackboard static-child structure,
participant-roster sync, profile-avatar events, notification sounds, and the
aggregate `webmeet-room` file. The new v5 private-route, identity, external TURN,
join-refresh, and state-remediation subset passed `36/36`.

## 8. Release conclusion

The implementation is intentionally **not marked complete**. The fixed two-port
physical boundary is proven, but the approved managed-bridge/private-listener
topology is not realizable on the observed rootless nested Podman network, so the
fresh full stack and both primary gates cannot pass. Release requires an explicit
architecture decision for DS004 Question #8, a rebuilt v5 box, then successful
reruns of both primary commands and every blocked native/external/browser lane.
