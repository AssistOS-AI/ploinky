# Ploinky Box Cloudflared Extraction and Token-Mode Implementation Plan

Date: 2026-07-28

Status: Ready to implement

## Objective

Move all Cloudflare Tunnel publication implementation out of `cli/server/RoutingServer.js` and
`cli/sandbox/cloudflarePublication*.js` into a cohesive
`ploinky-box/cloudflared/` module. Keep `RoutingServer.js` responsible only for the
small lifecycle boundary that connects Router listener readiness, detailed health, and shutdown
to that module.

Preserve the current API-managed Cloudflare publication mode. Add a connector-only mode in which
an operator supplies an existing Cloudflare Tunnel token through a Ploinky encrypted-secret
handle and Cloudflare already owns the tunnel ingress and DNS configuration. When neither
Cloudflare configuration nor public hosts are configured, preserve the current local-only
behavior and do not spawn `cloudflared`.

This is an internal architectural extraction plus a backward-compatible publication mode. It is
not a rewrite of the Router, the edge-generation system, or the outer Ploinky Box supervisor.

## Source-of-Truth and Worktree Guardrails

- Treat executable code and tests as the only source of truth.
- Do not read, cite, edit, or regenerate design-system specification files.
- Preserve all unrelated working-tree and index changes.
- In particular, do not modify, unstage, replace, or depend on the pre-existing staged file
  `docs/superpowers/specs/2026-07-28-ploinky-box-cloudflared-module-design.md`.
- Do not commit, push, deploy, or create Cloudflare resources as part of this implementation.
- Make the extraction behavior-preserving before adding connector-only behavior.

## Confirmed Current Architecture

| Area | Current behavior | Required outcome |
| --- | --- | --- |
| Router ownership | `cli/server/RoutingServer.js` owns listener readiness flags, starts the Cloudflare publication runtime after both listeners are ready, reports its status, and stops it before closing | Retain only calls into a `ploinky-box/cloudflared` lifecycle facade |
| Publication modules | Six `cloudflarePublication*.js` modules live under `cli/sandbox/` | Move the implementations into `ploinky-box/cloudflared/`; leave no compatibility copies |
| Route compilation | `cli/sandbox/edgeGeneration.js` validates desired Cloudflare shape and compiles exact public-host selectors | Keep general route compilation there; extend its publication disposition for connector-only mode |
| Route activation | `cli/sandbox/coordinatedEdgeApply.js` and the runtime coordinator enforce immutable-generation commits | Preserve this boundary; allow the connector-only controller to commit an exact generation to `error` |
| Public request policy | `cli/server/edgeRoutePlan.js` returns 421 for unknown hosts and 503 for configured but non-ready hosts | Preserve exactly |
| Cloudflare request metadata | `cli/server/routerHandlers.js` reads `cf-connecting-ip` for guest-rate-source metadata | Keep in Router; it is request policy, not tunnel process management |
| Connector security | The current connector uses an ephemeral `0600` token file, `--token-file`, a minimal environment, redaction, cleanup, and stop escalation | Preserve exactly |
| API-managed publication | The controller owns tunnel ingress reconciliation, ownership-safe DNS, remote verification, connection proof, external hostname proof, and teardown journal | Preserve exactly |
| Box image | `ploinky-box/entrypoint/ploinky-box-entrypoint` already installs pinned `cloudflared` and checks `--token-file` support | Make the image contract explicitly require the binary |
| Outer container | Host TCP maps to Router port 8080; UDP 7882 is published; environment is allowlisted | Add no new ports and do not expose the tunnel token through outer container environment |

## Target Module Boundary

Create this folder:

```text
ploinky-box/cloudflared/
  index.mjs
  routerIntegration.mjs
  runtime.mjs
  publicationController.mjs
  publicationPlan.mjs
  connector.mjs
  cloudflareApi.mjs
  journal.mjs
  status.mjs
```

Ownership is intentionally divided as follows:

| Module | Responsibility |
| --- | --- |
| `index.mjs` | Public exports for Router integration and focused tests |
| `routerIntegration.mjs` | Listener-readiness gate, start-once behavior, status forwarding, and idempotent shutdown |
| `runtime.mjs` | Active-generation polling, workspace mutation lease, retries, route coordinator, and external hostname proof |
| `publicationController.mjs` | Local-only, connector-only, and API-managed reconciliation state machines |
| `publicationPlan.mjs` | Strict normalization, mode classification, safe digest input, safe public summary, shared errors/redaction |
| `connector.mjs` | `cloudflared` child-process lifecycle and token-file hygiene |
| `cloudflareApi.mjs` | Scoped Cloudflare API calls used only by API-managed mode |
| `journal.mjs` | Ownership journal used only for Ploinky-managed Cloudflare API resources |
| `status.mjs` | Atomic, regular-file-only, `0600`, redacted runtime status persistence |

`ploinky-box/cloudflared/` is the code-ownership location. It does not make the outer Box
entrypoint the process parent. The Router process remains the parent so the tunnel cannot start
before both Router listeners are ready and is stopped before Router shutdown completes.

## Configuration Contract

Keep the existing broad publication mode values used by the routing coordinator:

| `mode` | Meaning |
| --- | --- |
| `local-only` | No public Cloudflare hosts and no Cloudflare credentials |
| `cloudflare` | Public Cloudflare hosts exist and either connector-only or API-managed publication is configured |

Add a normalized `management` discriminator:

| `management` | Accepted desired-state shape | Cloudflare mutations |
| --- | --- | --- |
| `null` | No `cloudflare` object and no `hosts` | None; no connector |
| `connector-only` | `cloudflare` contains exactly `tunnelTokenSecret`; one or more exact public `hosts` | None; run connector and externally prove preconfigured DNS/ingress |
| `api-managed` | Existing complete five-field tuple: `accountId`, `zoneId`, `tunnelId`, `tunnelTokenSecret`, `apiTokenSecret`; one or more exact public `hosts` | Existing ownership-safe ingress and DNS reconciliation |

Example connector-only desired state:

```json
{
  "hosts": {
    "office.example.com": {
      "agent": "AssistOSExplorer/onlyOffice"
    }
  },
  "cloudflare": {
    "tunnelTokenSecret": "publication/cloudflare-connector"
  }
}
```

The raw tunnel token remains in the encrypted Ploinky secret store, for example through the
existing `ploinky var` workflow. The desired-state document stores only the opaque
`tunnelTokenSecret` handle. Do not add `TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, or any raw
credential to the outer container environment, `container.mjs`, `process.mjs`, the generated
desired-state document, status, logs, or the ownership journal.

Reject all ambiguous partial configurations:

| Shape | Result |
| --- | --- |
| Hosts without Cloudflare configuration | Configuration error |
| Tunnel-token handle without at least one host | Configuration error |
| Connector-only fields mixed with any API-managed scope/API field but not the complete tuple | Partial-configuration error |
| Complete API-managed tuple without a host | Configuration error |
| Unsupported Cloudflare keys | Configuration error |
| Same secret handle for connector token and API token | Existing secret-separation error |

Continue to require exact lower-case public DNS hostnames and the existing validated route
selector for every host.

## Security and Availability Invariants

1. A raw token must never appear in command-line arguments, logs, audit values, status files,
   journals, desired-state digests, exception text, process environment, or container inspection.
2. The connector token is resolved only at runtime from its opaque encrypted-store handle.
3. `cloudflared` continues to receive the token through a short-lived, regular, `0600` file under
   `/run/ploinky/cloudflared/`.
4. Local control hosts remain usable during reconciliation and after publication failure.
5. A configured public hostname never becomes routable before external proof succeeds.
6. Unknown hosts remain 421. Configured public hosts in `reconciling` or `error` remain 503.
7. A stale controller may commit only the exact immutable generation it captured.
8. Connector-only mode performs zero Cloudflare API calls and owns zero remote resources.
9. API-managed mode retains its current ownership-aware DNS/ingress journal and teardown rules.
10. Shutdown waits for the connector lifecycle to stop before Router listeners close.

## Implementation Sequence

### Phase 0: Establish the Baseline

- [ ] Record `git status --short`; identify and preserve unrelated changes.
- [ ] Run the current focused baseline:

  ```bash
  node --test \
    tests/unit/cloudflarePublicationPlan.test.mjs \
    tests/unit/cloudflarePublicationInfrastructure.test.mjs \
    tests/unit/cloudflarePublicationController.test.mjs \
    tests/unit/cloudflarePublicationRuntime.test.mjs \
    tests/unit/ploinkyBoxSupervisor.test.mjs
  ```

- [ ] Confirm that the pre-existing staged design artifact is unchanged before and after work.

### Phase 1: Extract the Existing Implementation Without Behavior Changes

- [ ] Move the current modules and preserve their exported behavior:

  | From | To |
  | --- | --- |
  | `cli/sandbox/cloudflarePublication.js` | `ploinky-box/cloudflared/publicationController.mjs` |
  | `cli/sandbox/cloudflarePublicationApi.js` | `ploinky-box/cloudflared/cloudflareApi.mjs` |
  | `cli/sandbox/cloudflarePublicationConnector.js` | `ploinky-box/cloudflared/connector.mjs` |
  | `cli/sandbox/cloudflarePublicationJournal.js` | `ploinky-box/cloudflared/journal.mjs` |
  | `cli/sandbox/cloudflarePublicationPlan.js` | `ploinky-box/cloudflared/publicationPlan.mjs` |
  | `cli/sandbox/cloudflarePublicationRuntime.js` | `ploinky-box/cloudflared/runtime.mjs` |

- [ ] Adjust imports for the new directory depth. Shared routing and workspace utilities remain
  in their present modules; do not duplicate them under `ploinky-box/cloudflared/`.
- [ ] Extract the runtime's atomic status-file writer into `status.mjs`; initially preserve the
  exact current format and permissions.
- [ ] Add `index.mjs` with an intentionally small public surface. At minimum, export the Router
  integration factory; export lower-level factories only when an existing focused test needs
  direct construction.
- [ ] Update existing tests to import the moved modules.
- [ ] Remove the old `cli/sandbox/cloudflarePublication*.js` modules. Do not leave long-lived
  forwarding shims that preserve the old ownership boundary.
- [ ] Run the four existing Cloudflare-focused test files. Resolve extraction regressions before
  adding new behavior.

### Phase 2: Replace Router Internals With a Thin Integration Facade

- [ ] Implement `createCloudflaredRouterIntegration` in `routerIntegration.mjs` with injected
  `audit` and `runtimeFactory` dependencies.
- [ ] Give the facade only these lifecycle responsibilities:

  | Method | Contract |
  | --- | --- |
  | `markPublicListenerReady()` | Mark public listener ready and start exactly once if private is also ready |
  | `markPrivateListenerReady()` | Mark private listener ready and start exactly once if public is also ready |
  | `getStatus()` | Return the last safe runtime status or the local/unstarted status |
  | `stop()` | Idempotently stop an active runtime and await completion |

- [ ] If runtime construction throws, retain a safe error status and audit only structured,
  redacted metadata. Do not crash the already-listening local Router solely because optional
  public publication failed.
- [ ] Update `cli/server/RoutingServer.js` to:

  - import the facade through `../../ploinky-box/cloudflared/index.mjs`;
  - construct one facade alongside other Router lifecycle services;
  - notify it from the existing public and private listener callbacks;
  - read `getStatus()` for detailed health;
  - `await stop()` from the existing `beforeClose` hook.

- [ ] Remove the Cloudflare runtime variable, both readiness flags, and
  `maybeStartCloudflarePublicationRuntime` from `RoutingServer.js`.
- [ ] Do not move exact-Host selection, public 421/503 behavior, edge proof handling, or
  `cf-connecting-ip` request metadata out of Router.
- [ ] Add `tests/unit/cloudflaredRouterIntegration.test.mjs` covering:

  - each listener-ready ordering;
  - no start after only one listener;
  - exactly one start after repeated notifications;
  - safe construction failure;
  - status forwarding;
  - stop before start;
  - idempotent awaited stop.

### Phase 3: Normalize Connector-Only Configuration

- [ ] Refactor `publicationPlan.mjs` so strict Cloudflare parsing first classifies the tuple as
  absent, connector-only, API-managed, or invalid partial.
- [ ] Preserve `mode: "cloudflare"` for both Cloudflare variants and add
  `management: "connector-only" | "api-managed"`.
- [ ] Connector-only plans contain:

  - exact normalized hosts and their validated selectors;
  - the immutable configuration generation;
  - the fixed Router origin service needed for diagnostics/proof semantics;
  - `secretHandles.tunnelToken`;
  - no API token handle, account/zone/tunnel scope, DNS mutation plan, or managed ingress plan.

- [ ] API-managed plans retain the current scope, ingress, DNS, and separate secret handles.
- [ ] Keep raw secret values and secret-handle names out of `desiredDigest`. Include the
  management discriminator so connector-only and API-managed plans cannot collide.
- [ ] Extend `publicPlanSummary` with `management`; never expose secret handles.
- [ ] Update `publicationDisposition` in `cli/sandbox/edgeGeneration.js`:

  - absent configuration remains local-only and defaults to `ready`;
  - connector-only plus hosts is complete Cloudflare and defaults to `reconciling`;
  - the existing complete tuple plus hosts remains complete Cloudflare and defaults to
    `reconciling`;
  - every partial shape is incomplete and defaults to `error`.

- [ ] Add/extend plan and edge-generation tests for every accepted and rejected shape, stable
  ordering, digest separation, and secret-handle omission.

### Phase 4: Implement the Connector-Only Controller Branch

- [ ] In `publicationController.mjs`, branch on normalized `management` after handling
  local-only.
- [ ] Split secret resolution:

  - connector-only resolves only `secretHandles.tunnelToken`;
  - API-managed resolves the existing connector and API handles separately.

- [ ] Connector-only reconciliation must execute this state machine:

  ```text
  capture exact generation
      -> commit exact generation as reconciling
      -> resolve tunnel token
      -> start cloudflared
      -> externally probe every configured hostname
      -> commit the same exact generation as ready
  ```

- [ ] The pre-ready external proof remains the existing HTTPS proof endpoint behavior: while the
  generation is `reconciling`, every expected public host must reach this Router and return the
  generation-specific inactive proof response. Preserve the original public Host header; do not
  add a Host override.
- [ ] Connector-only mode must not:

  - instantiate or call the Cloudflare API client;
  - list or prove tunnel connections through the API;
  - reconcile tunnel ingress;
  - create, update, or delete DNS;
  - write resource ownership entries to the API-managed journal.

- [ ] On missing/invalid token, connector exit, proof timeout, wrong DNS/ingress, or a stale
  generation:

  - stop the connector;
  - commit the exact captured connector-only generation to `error` when it is still selected;
  - keep local control routes active;
  - keep configured public hosts at 503;
  - preserve the existing bounded exponential-retry policy for retryable errors.

- [ ] Extend the route coordinator in `runtime.mjs` to accept `publicationState: "error"` only
  for the exact captured Cloudflare generation and exact desired host semantics. Local-only may
  still commit only `ready`. Preserve fail-closed behavior for stale or mismatched commits.
- [ ] Preserve the existing API-managed state machine and failure semantics. Refactor shared
  connector/proof code only after the connector-only path is independently tested.

### Phase 5: Protect API-Managed Resource Ownership Across Mode Transitions

- [ ] Treat `journal.mjs` as an API-managed resource-ownership journal, not a general connector
  status store.
- [ ] Reject a direct API-managed-to-connector-only transition when the journal records resources
  that Ploinky still owns. Return a stable, actionable error explaining the safe transition:

  ```text
  apply local-only first -> verify API-managed teardown -> apply connector-only
  ```

- [ ] The local-only teardown step must continue to use the old API-managed scope and API secret
  handles available to the selected generation so ownership-safe cleanup can complete.
- [ ] Connector-only must not erase the journal to bypass this guard.
- [ ] Add tests for:

  - direct transition rejection;
  - journal left intact after rejection;
  - API-managed to local-only teardown;
  - local-only to connector-only after the journal is clean.

### Phase 6: Make Runtime Status a Box-Owned, Redacted Contract

- [ ] Implement status writing in `status.mjs` with the current atomic replace, regular-file
  validation, parent-directory permissions, final `0600` mode, and temporary-file cleanup.
- [ ] Persist only an allowlisted shape:

  | Field | Allowed value |
  | --- | --- |
  | `mode` | `local-only` or `cloudflare` |
  | `management` | `null`, `connector-only`, or `api-managed` |
  | `state` | lifecycle state such as `ready`, `reconciling`, `error`, or `stopped` |
  | `connectorState` | safe connector lifecycle label only |
  | `configurationGeneration` | immutable generation digest |
  | `desiredDigest` | redacted plan digest |
  | `hostnames` | normalized public hostnames |
  | `error` | optional `{ code, operation, retryable }`; no free-form message |

- [ ] Add a defensive status serializer so extra controller fields cannot leak into the file.
- [ ] Extend `ploinky-box/inbox/readStatus.mjs` to read
  `.ploinky/run/cloudflare-publication-status.json` only when it is a regular, non-symlink file
  and to return only the allowlisted fields.
- [ ] Extend the existing Ploinky Box status rendering/allowlist in `ploinky-box/supervisor.mjs`
  with concise Cloudflare mode, management, publication state, connector state, and host count.
  A missing file means local/unstarted, not a supervisor failure.
- [ ] Do not make the outer supervisor start, stop, or restart `cloudflared`.
- [ ] Extend `ploinkyBoxInbox.test.mjs` and `ploinkyBoxSupervisor.test.mjs` for normal, missing,
  malformed, symlink, and secret-like extra-field cases.

### Phase 7: Tighten the Image Contract

- [ ] Add `cloudflared` to `IMAGE_CONTRACT.requiredBinaries` in
  `ploinky-box/contract/image.mjs`.
- [ ] Preserve the existing pinned install and `--token-file` validation in
  `ploinky-box/entrypoint/ploinky-box-entrypoint`.
- [ ] Extend `tests/unit/ploinkyBoxImageContract.test.mjs` to prove the binary is required and
  the entrypoint validates token-file support.

### Phase 8: Complete the Test Matrix

- [ ] Update moved-module imports in all existing focused tests.
- [ ] Add connector-only plan tests:

  - valid token handle plus one/multiple hosts;
  - no hosts;
  - hosts without a token handle;
  - unsupported or mixed partial fields;
  - API-managed regression;
  - digest and public-summary redaction.

- [ ] Add connector-only controller tests:

  - zero API calls and zero ownership-journal writes;
  - every host is externally proved;
  - missing secret handle/value;
  - connector spawn/exit failure;
  - proof timeout or wrong endpoint;
  - success commits `reconciling` then `ready`;
  - failure commits `error`, stops the connector, preserves local routing, and schedules bounded
    retry;
  - stale generation cannot commit;
  - transition journal guard.

- [ ] Add runtime/coordinator tests:

  - exact connector-only generation may commit `error`;
  - mismatched generation/mode/hosts cannot commit;
  - local-only cannot commit `error`;
  - configured public hosts remain non-ready in `reconciling` and `error`.

- [ ] Preserve and rerun connector-infrastructure tests for token-file permissions, no token in
  argv, minimal environment, redaction, cleanup, and stop escalation.
- [ ] Extend `edgeGenerationHardCut.test.mjs` for connector-only compilation and public-host
  readiness behavior.
- [ ] Rerun `runtimeSourceAbsence.test.mjs`; the new folder must not reintroduce the retired
  standalone component, AgentServer, dashboard, MCP surface, or obsolete ports.

## Required Verification

Run from the Ploinky repository root:

```bash
node --test \
  tests/unit/cloudflaredRouterIntegration.test.mjs \
  tests/unit/cloudflarePublicationPlan.test.mjs \
  tests/unit/cloudflarePublicationInfrastructure.test.mjs \
  tests/unit/cloudflarePublicationController.test.mjs \
  tests/unit/cloudflarePublicationRuntime.test.mjs \
  tests/unit/edgeGenerationHardCut.test.mjs \
  tests/unit/ploinkyBoxImageContract.test.mjs \
  tests/unit/ploinkyBoxInbox.test.mjs \
  tests/unit/ploinkyBoxSupervisor.test.mjs \
  tests/unit/runtimeSourceAbsence.test.mjs

npm test
```

Also run:

```bash
git diff --check
git status --short
```

If the environment prevents a test from running, report the exact command, exit result, and
environmental blocker. Do not substitute an unverified success claim.

## Acceptance Criteria

| Criterion | Verification |
| --- | --- |
| Cloudflare implementation has one ownership folder | `ploinky-box/cloudflared/` contains the implementation; old `cli/sandbox/cloudflarePublication*.js` files are absent |
| Router is a thin lifecycle consumer | `RoutingServer.js` contains only facade construction, two readiness notifications, status read, and awaited stop |
| Local default is unchanged | No Cloudflare configuration and no hosts starts no child process and local health/routes remain available |
| Connector-only works with an existing tunnel | Token handle plus exact hosts starts `cloudflared`, performs no API/DNS mutation, and reaches `ready` only after all external proofs |
| Connector-only failure is safe | Connector stops; local control remains healthy; public configured hosts remain unavailable; safe status is `error`; retry is bounded |
| API-managed behavior is preserved | Existing scope, ingress, DNS ownership, connection proof, external proof, teardown, and tests remain green |
| Transition cannot orphan resources | Direct API-managed-to-connector-only change is rejected while the ownership journal is non-empty |
| Credentials do not leak | Raw tokens and secret handles are absent from argv, logs, audits, status, journal payloads, digest inputs, and container environment |
| Exact-Host boundary is unchanged | Unknown public Host is 421; selected but non-ready Host is 503; no wildcard or Host override is introduced |
| Lifecycle is deterministic | Runtime starts once after both listeners and stops before Router close |
| Image is self-consistent | `cloudflared` is installed, token-file capable, and required by the image contract |
| Unrelated user work is preserved | The pre-existing staged design artifact and any other unrelated changes are byte-for-byte and stage-state unchanged |
| Verification is complete | Focused tests, full `npm test`, `git diff --check`, and status review succeed or exact blockers are reported |

## Explicit Non-Goals

- Do not create a new Cloudflare tunnel, quick tunnel, hostname, ingress rule, or DNS record in
  connector-only mode.
- Do not copy the standalone `basic/cloudflared` AgentServer, MCP tools, dashboard, manifest,
  supervisor, or image structure.
- Do not introduce port 8082, a second HTTP listener, a second container, or a second supervisor.
- Do not add a local `cloudflared` YAML configuration file.
- Do not move general edge-generation, exact-Host routing, proof endpoint, or request metadata
  policy into the cloudflared module.
- Do not use `host.containers.internal`; the connector origin remains the Router loopback
  listener at `http://127.0.0.1:8080`.
- Do not change outer container port publication or pass raw secrets through outer container
  environment.
- Do not weaken API-managed ownership checks or delete journal state to force a mode transition.
- Do not update documentation outside this implementation plan unless an executable user-facing
  configuration example is required by an existing test or command contract.

## Implementation Completion Report

The implementation task should finish with:

1. A concise description of the final ownership and lifecycle boundary.
2. The connector-only configuration example actually supported by code.
3. A file summary grouped by extraction, behavior, status, and tests.
4. Exact focused-test and full-suite results.
5. Any remaining risk or environmental blocker.
6. Confirmation that no commit, push, deployment, Cloudflare mutation, or unrelated-file change
   was performed.
