# Task 5 Report: HTTP Router Proxy MVP Smoke

## Implemented

- Added `tests/fixtures/http-router-service/` with a public `httpServices`
  route on private port `7000` and a minimal Node HTTP server.
- Added standalone `container/smoke-http-router.mjs`. It creates a disposable
  workspace and uniquely named box, validates the fixture declaration, starts
  the runtime through the normal CLI path, copies the fixture into the box,
  starts the service, and checks the Router response plus exact outer
  publications before and after one shutdown/restart. Its cleanup removes only
  the disposable container, named volumes, and temporary workspace.
- Added the required source-inspection prerequisite test to
  `tests/unit/smokeFullGraphPrerequisites.test.mjs`.
- Synchronized the directly affected DS003, DS004, DS005, and DS010 content
  plus `spec-agent.html`, `runtime.html`, `interfaces.html`, `operations.html`,
  and `container/README.md`.

## TDD RED

Command:

```sh
node --test tests/unit/smokeFullGraphPrerequisites.test.mjs
```

Result: 2 passing tests and 1 expected failure. The new test failed with
`ENOENT` for missing `container/smoke-http-router.mjs`, before the smoke and
fixture were created.

## GREEN Verification

Focused prerequisite test:

```sh
node --test tests/unit/smokeFullGraphPrerequisites.test.mjs
```

Result: 3 passed, 0 failed.

Combined focused unit gate:

```sh
node --test container/runtime-supervisor-tests.mjs tests/unit/httpServiceManifestValidation.test.mjs tests/unit/edgeGenerationHardCut.test.mjs tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/workspaceDependencyGraph.test.mjs tests/unit/smokeFullGraphPrerequisites.test.mjs
```

Result: 311 passed, 0 failed.

Real-engine smoke:

```sh
SMOKE_PORT=18080 node container/smoke-http-router.mjs
```

Result: rootless Podman was available: both `podman info` and the rootless
probe passed. The smoke then failed before fixture copy/start because pulling
`docker.io/assistos/ploinky-box:runtime` produced an image labeled runtime
contract `3`; this checkout requires contract `5`. Exact diagnostic:

```text
Runtime image 'docker.io/assistos/ploinky-box:runtime' has invalid io.assistos.ploinky.runtime-contract; expected "5", observed "3"
```

No disposable container or named smoke volume was created before that failure;
the smoke `finally` cleanup ran.

## Documentation Verification

Command:

```sh
rg -n "httpServices\\[\\]\\.port|hostPort|hostIp|publish|publishedPort|expose|listenLan|compiled\\.services|127\\.0\\.0\\.1:<selected-router-host-port>:8080/tcp|0\\.0\\.0\\.0:7882:7882/udp|routing-probe" docs/specs/DS003-agent-manifest-and-registry.md docs/specs/DS004-runtime-execution-and-isolation.md docs/specs/DS005-routing-and-web-surfaces.md docs/specs/DS010-testing-and-verification.md docs/spec-agent.html docs/runtime.html docs/interfaces.html docs/operations.html container/README.md
```

Result: all required contract markers were found in the directly affected docs.

`git diff --check` also completed with no whitespace errors.

## Files Changed

- `container/smoke-http-router.mjs`
- `container/README.md`
- `tests/fixtures/http-router-service/manifest.json`
- `tests/fixtures/http-router-service/server.mjs`
- `tests/unit/smokeFullGraphPrerequisites.test.mjs`
- `docs/specs/DS003-agent-manifest-and-registry.md`
- `docs/specs/DS004-runtime-execution-and-isolation.md`
- `docs/specs/DS005-routing-and-web-surfaces.md`
- `docs/specs/DS010-testing-and-verification.md`
- `docs/spec-agent.html`
- `docs/runtime.html`
- `docs/interfaces.html`
- `docs/operations.html`

## Self-Review

The smoke contains no full-graph, Explorer, Cloudflare, TURN, browser, release,
or multi-product gate. It does not create Router-owned bindings files, does not
add `httpEndpoints`, and compares both `HostConfig.PortBindings` and `podman
port` against only the selected loopback Router TCP mapping plus fixed UDP
`7882`. It explicitly rejects outer `7000/tcp`, `8081/tcp`, `7880/tcp`, and
`7881/tcp` publications in both start phases.

## Concern

The published runtime image tag currently exposes contract `3`, preventing the
required real-engine request and restart assertions from executing against a
contract-5 box. The implementation and focused unit gates are complete; rerun
the smoke with a contract-5 `SMOKE_IMAGE` once that image is available.

## Task 5 Smoke Blocker Fix - Installer Worktree CWD

### RED Verification

Command:

```sh
node --test --test-name-pattern 'dependency installer runs npm outside a broken worktree source root' container/runtime-supervisor-tests.mjs
```

Result: failed as expected before the installer fix. The fake `npm` observed
`PWD == PLOINKY_ROOT` and exited with status `42`; the test failed with
`AssertionError [ERR_ASSERTION]: npm ran from PLOINKY_ROOT`.

### GREEN Verification

Focused regression:

```sh
node --test --test-name-pattern 'dependency installer runs npm outside a broken worktree source root' container/runtime-supervisor-tests.mjs
```

Result: 1 passed, 0 failed.

Runtime supervisor test file:

```sh
node --test container/runtime-supervisor-tests.mjs
```

Result: 147 passed, 0 failed.

Combined requested gate:

```sh
node --test container/runtime-supervisor-tests.mjs tests/unit/smokeFullGraphPrerequisites.test.mjs
```

Result: 150 passed, 0 failed.

Whitespace check:

```sh
git diff --check
```

Result: completed with no whitespace errors.

### Commit

Fix commit: `35943565c79f6fcd3ef9eb3c565331cb7063e833`

### Files Changed

- `bin/ploinky-install-deps`
- `container/runtime-supervisor-tests.mjs`

### Concern

No remaining concern for this blocker. The installer now invokes `npm` from a
neutral temp directory with `--prefix "$PLOINKY_ROOT"`, preserving the existing
install arguments and avoiding Git discovery from a broken worktree `.git`
pointer under the read-only source mount.
