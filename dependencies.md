# Dependencies for graph skill scope persistence

AchillesAgentLib source selection and Box bundle verification use Node.js built-ins
and add no third-party packages. The existing library is pinned in
`ploinky-box/dependencies.lock.json` and bundled by the `container-image-builds`
Box workflow, including its declared runtime dependencies and license files.
The bundle contains the existing `ploinky-agent-lib` package (MIT, with its
upstream LICENSE retained); its source URL and immutable revision are recorded
in that lock. To update it, update the pin and rebuild the Box image. A valid
workspace checkout remains the development override. Host Git and network
access are no longer needed to acquire a fallback library; other repository
operations retain their own Git requirements. Startup rejects absent, changed,
or incompatible bundles before admitting the graph. Focused verification uses
the existing Node test runner and fake container engine, without installations.

The graph scope state implementation and its regression tests add no third-party dependencies. They use Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:os`, `node:test`, and `node:assert/strict`) and repository-owned modules. Node.js is a runtime prerequisite, not a bundled library; the focused tests were verified with Node.js 25.8.0 and the portable acceptance runner targets Node.js 22 or newer.

Existing application dependencies and installation behavior remain declared in `package.json`. This change does not install packages, download tools, or alter those dependencies. Scope-state reads and writes run in the existing host supervisor and require its workspace mutation lock. A missing saved scope is handled as legacy state; malformed state produces an explicit error before graph mutation.

Authority-helper command diagnostics use only Node.js built-ins (`node:crypto`
and `node:util`) and the existing diagnostic sanitizer. They add no third-party
dependencies or installation requirements. Their regression tests use the
existing fake Podman runner and Node.js test runner.

Box readiness separates stored container records from host diagnostics using
the existing Podman CLI's `container logs --timestamps` format. It adds no
packages or system services. Podman 5.4.0+ remains the supported native host
baseline; stored timestamps are retained for history checks, and host log-reader
errors prevent readiness even when the command exits successfully. The format
is defined by [Podman's log writer](https://github.com/containers/podman/blob/v5.8.6/libpod/logs/log.go).
Focused regression tests use Node.js built-ins. The opt-in native regression
uses an existing immutable local image with `/bin/sh` and the installed Podman
to check journald and k8s-file logging. It creates and removes only its labelled
fixtures, without image pulls, published ports or host mounts. Run it with
`PLOINKY_LOG_TEST_IMAGE=<immutable-image-id> node --test tests/integration/ploinkyBoxLogDiagnostics.test.mjs`.

The native Linux host preflight adds no third-party code or packages. It uses
Node.js filesystem/path APIs, the existing bounded process runner, and the
existing diagnostic sanitizer. The public launcher requires Node.js 22+ before
loading modules. The supported native host baseline is Podman 5.4.0+; its
selected runtime, networking, and configured storage helpers remain external
system prerequisites, with the effective paths read from `podman info`.
Rootless UID/GID helpers, namespace mappings, seccomp, and FUSE/TUN device access
are checked before Box preparation. Host cgroup versions and controller
delegation are not prerequisites for the current Box runtime, which disables
nested cgroups and sets no outer CPU quota. Installation and
configuration guidance is in [README.md](README.md#prerequisites) and in each
failure message. These checks neither install packages nor alter host settings.
The host's configured packages retain their distribution/upstream licensing;
none is newly vendored or redistributed by this change. Regression tests use
fake filesystems and process runners and need no container engine.

The focused tests substitute container operations and require no container engine or model backend. The broader acceptance harness can optionally use an existing Podman installation to provide Linux; its environment requirements are documented with that harness. No external code, licenses, or notices were added by this component.

The cross-repository propagation tests are available through `npm run test:local-skills`. Their explicit source and optional native-runtime prerequisites are recorded in [tests/integration/local-skills/dependencies.md](tests/integration/local-skills/dependencies.md). They add no third-party packages.

The managed AgentLib package adapter adds no dependencies. It uses Node.js
filesystem and path APIs to inspect npm package placements and replace cache-owned
copies with links to the already admitted library. Both `achillesAgentLib` and
`ploinky-agent-lib` resolve from that source; standalone packages keep their own
installation contracts. The adapter changes neither source manifests nor the
selected library, and its regression tests use temporary directories and the
existing mocked Box installer. No new package, external source, license, or
tool installation is required.
