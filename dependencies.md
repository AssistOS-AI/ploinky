# Dependencies for graph skill scope persistence

The graph scope state implementation and its regression tests add no third-party dependencies. They use Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:os`, `node:test`, and `node:assert/strict`) and repository-owned modules. Node.js is a runtime prerequisite, not a bundled library; the focused tests were verified with Node.js 25.8.0 and the portable acceptance runner targets Node.js 22 or newer.

Existing application dependencies and installation behavior remain declared in `package.json`. This change does not install packages, download tools, or alter those dependencies. Scope-state reads and writes run in the existing host supervisor and require its workspace mutation lock. A missing saved scope is handled as legacy state; malformed state produces an explicit error before graph mutation.

The focused tests substitute container operations and require no container engine or model backend. The broader acceptance harness can optionally use an existing Podman installation to provide Linux; its environment requirements are documented with that harness. No external code, licenses, or notices were added by this component.

The cross-repository propagation tests are available through `npm run test:local-skills`. Their explicit source and optional native-runtime prerequisites are recorded in [tests/integration/local-skills/dependencies.md](tests/integration/local-skills/dependencies.md). They add no third-party packages.
