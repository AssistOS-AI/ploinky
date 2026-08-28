# WebTTY agent PTY lifecycle spike results

| Field | Value |
| --- | --- |
| Date | 2026-08-28 |
| Result | **Blocked: no backend selected** |
| Production Box source | Ploinky `e73c3189652841362669d433a2c8f442ae59b269` |
| Production image definition | `container-image-builds` `1751b13705c5b6e6eb371c267f37dd4b8bcc184e` |
| Candidate image ID | `sha256:2470a215b6f647c15560cf39bb738e21484ba7fd8bbe8a28133f1df3f4c0b507` |
| Candidate OCI digest | `sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f` |
| Local-only tag | `localhost/ploinky-box-phase0-webtty:e73c3189-1751b137-20260828t1001c` |
| Production agent image | `docker.io/assistos/ploinky-node:24-bookworm-tools` |

## Decision

Neither allowed candidate passes the mandatory lifecycle gate in the exact production
`ploinky-box`/nested-rootless-Podman topology. No production agent PTY provider,
worker protocol, init argv, readiness frame, or recovery record is selected.

- Controlled `podman exec -it` under Box `node-pty` creates an exact exec and a
  marker-bearing inner shell, but interactive input/output does not cross the
  double-PTY boundary. The server-owned numeric readiness frame times out.
- The Podman REST candidate creates and attaches an exact exec, but no
  non-echoable numeric readiness frame returns across the upgraded socket. An
  explicit application input roundtrip is required before resize and is not
  reached.
- Exact termination, foreground-child reclamation, worker-crash recovery, and
  post-close orphan proof therefore cannot be demonstrated for either candidate.

Section 6.3 of the implementation plan requires the implementation to stop and
request an architecture decision in this state. The spike did not add a broker,
helper image, privilege, host bind, generic exec endpoint, or agent-side
`node-pty`.

## Reproducible inputs

The image-definition checkout was clean at commit
`1751b13705c5b6e6eb371c267f37dd4b8bcc184e` (tree
`4e346d79b6452f62df1788036bc4106659dcb196`). Its disposable `sources/ploinky`
checkout was clean at commit `e73c3189652841362669d433a2c8f442ae59b269`
(tree `47d6fb1e883b4a07c76decaa7509fc4d734aa182`). Relevant input hashes were:

| Input | SHA-256 |
| --- | --- |
| `images/ploinky-box/Dockerfile` | `b8052316422c76e27aba3756fc5a9096da8d74b8d589a12166ff8a464b5281a4` |
| `core-services/webtty/package-lock.json` | `3eec51e517db1ba30c6ef523be83640cd0484b910adfa54a11692e020ea06a6a` |
| `core-services/webtty/native-probe.mjs` | `d5d87c7a0c2abb00f303fe4092aef44712e1567c8f0f1c0522c302af2953d20e` |

The retained local-only candidate was built from the unmodified production
Dockerfile final stage with:

```sh
podman build \
  --no-cache \
  --identity-label=false \
  --unsetlabel io.buildah.version \
  --platform linux/arm64 \
  --build-arg PLOINKY_SOURCE_SHA=e73c3189652841362669d433a2c8f442ae59b269 \
  --tag localhost/ploinky-box-phase0-webtty:e73c3189-1751b137-20260828t1001c \
  --file images/ploinky-box/Dockerfile \
  .
```

No public tag was moved and the image was not pushed. The candidate has no
configuration labels. A first local build that accidentally retained Buildah's
automatic identity label was rejected before admission and subsequently removed.

## Runtime inventory and prerequisite gates

| Item | Observed value |
| --- | --- |
| Box user | UID 1000, GID 1000 (`podman`) |
| Box Node.js | `v24.19.0`, ABI `137` |
| Box `node-pty` | `1.0.0` |
| Box / nested Podman client | `5.8.2`, API `5.8.2`, commit `5b263b5f5b48004a87caac44e67349a8266d9ef4` |
| Nested runtime | Rootless, graph root `/home/podman/.local/share/containers/storage`, run root `/tmp/storage-run-1000` |
| Nested socket | `/run/user/1000/podman/podman.sock` |
| Agent image ID | `cf5afc2995b3b7f747ae03c8a2f20af4b17d4e9d7db790716a0aeea1a2a3cd87` |
| Agent arm64 digest | `sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03` |
| Agent configured user | `1000:1000` |

The embedded native probe passed import, input, output, resize, exit, reap, and
identity checks. Its native artifact was
`/usr/local/lib/ploinky/webtty/node_modules/node-pty/build/Release/pty.node`
with SHA-256
`07e255bda62c4bfe0c0f522259e39fe09348f99ec3039284f553a696760195ad`.

The existing non-browser image/native contract gates passed 22 of 22 tests with
zero failures, skips, or todos:

```sh
node --test \
  tests/unit/webttyNativeRuntime.test.mjs \
  tests/unit/ploinkyBoxImageContract.test.mjs
```

## Candidate 1: controlled CLI under Box `node-pty`

The exact server-owned launch shape used the full immutable 64-hex container ID:

```text
/usr/bin/podman container exec --interactive --tty
  --user <0:0-or-1000:1000>
  --workdir /tmp
  --env PLOINKY_WEBTTY_MARKER=<server-random-marker>
  --env TERM=xterm-256color
  <full-container-id>
  /bin/bash -c
  'exec -a "$PLOINKY_WEBTTY_MARKER" /bin/bash --noprofile --norc'
```

Before accepting browser traffic, the harness required all of the following:

1. The Box-side Podman client PID/start token existed.
2. Inspecting the exact container returned exactly one engine exec ID.
3. An exact-container `/proc/*/environ` scan found the random marker in the inner
   shell and recorded its PID, process group, session, and start token.
4. The worker wrote a server-owned frame through Box `node-pty` and required an
   exact numeric response:

```text
__PLOINKY_READY__<marker>|<pid>|<pgrp>|<session>|<uid>
```

The first three checks passed. The fourth timed out after 10 seconds with no
numeric frame, so root-agent interactive I/O failed before resize or normal
close. The error path then reproduced a second defect while stopping the live
target:

```text
getting the PID handle for pid <pid> from 'name-to-handle:<token>':
openByHandleAt failed: operation not permitted
```

This result was reproduced with the candidate selector below. It is intentionally
a failing stop-gate test, not a skipped test:

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f \
PLOINKY_WEBTTY_AGENT_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools \
PLOINKY_WEBTTY_PHASE0_FIRST_CANDIDATE=cli \
node --test tests/integration/webttyAgentPtyLifecycle.test.mjs
```

Result: 0 passed, 1 failed, 0 skipped; failure stage `root-normal`.

## Candidate 2: local Podman REST exec

The harness created a unique service directory with mode `0700`, exposed a
unique Unix socket readable only by the Box user, verified `/_ping` and
`/version`, and used the full immutable container ID for `POST
/v5.0.0/containers/<id>/exec`. The returned 64-hex exec ID was attached via a
101 Upgrade response.

The corrected harness then wrote a server-owned command whose echo cannot match
the required numeric frame:

```text
__PLOINKY_REST_READY__<marker>|<pid>|<pgrp>|<session>|<uid>
```

That exact readiness frame timed out after 10 seconds. The harness requires the
numeric PID/session evidence, an actual marker-bearing process match, engine
correlation to the returned exec ID, and an explicit application input
roundtrip before it will call resize. None of those downstream checks was
credited, and resize was not attempted in the corrected run.

An earlier echo-vulnerable probe had mistaken the echoed readiness command for
application output and proceeded to a resize call. Its apparent readiness and
I/O results are invalid and are not evidence for either backend. The corrected
regression prevents that false positive.

During error cleanup, stopping the live target also returned the nested-rootless
runtime error `openByHandleAt failed: operation not permitted`. The enclosing
Box removal still reclaimed the disposable nested runtime.

The retained default command reproduces the REST-first failure:

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f \
PLOINKY_WEBTTY_AGENT_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools \
node --test tests/integration/webttyAgentPtyLifecycle.test.mjs
```

Result: 0 passed, 1 failed, 0 skipped; failure stage `rest-candidate`.

## Matrix disposition

| Required case | CLI/node-pty | REST |
| --- | --- | --- |
| Exact image/runtime inventory | Passed | Passed |
| Immutable container and exec identity | Passed | Exact container create and 64-hex exec attach passed; post-readiness engine correlation blocked |
| Marker present in an actual inner process | Passed | Blocked by numeric readiness failure |
| Bidirectional interactive I/O | **Failed** | **Failed**: no numeric readiness; explicit application roundtrip not reached |
| Resize verified by inner `stty size` | Not reachable after I/O failure | Not attempted after corrected readiness failure |
| Root and non-root normal close | Blocked by earlier mandatory failure | Blocked by earlier mandatory failure |
| Box client death/reclaim | Blocked by earlier mandatory failure | Not applicable to this transport; service/attach crash gate blocked |
| Foreground-child cleanup | Blocked by earlier mandatory failure | Blocked by earlier mandatory failure |
| Target stop/remove and same-name replacement | Error path exposed `openByHandleAt` defect; full proof blocked | Blocked by earlier mandatory failure |
| Worker crash/recovery | Blocked by earlier mandatory failure | Blocked by earlier mandatory failure |
| Orphan audit after every close | Not proven | Not proven |

The unexecuted rows are not skips reported as success. They are downstream cases
that the Phase 0 stop gate deliberately prevents after a prerequisite lifecycle
operation fails.

## Cleanup proof

Every run used a random `io.assistos.ploinky.phase0=<run-id>` label, unique inner
container names, a unique REST socket directory, and a unique outer Box fixture
root. After each failed run, the enclosing exact Box was removed, the unique
fixture root was removed, and the host was audited.

Final audit:

- zero host containers with an `io.assistos.ploinky.phase0` label;
- zero `ploinky-box-podman-*` fixture roots under the host temporary directory;
- no retained Phase 0 REST service or socket directory;
- the rejected identity-labeled image ID was removed;
- only the pinned local-only candidate image and its two local references remain
  for independent inspection;
- the shared Podman machine remains `running` and was not restarted.

The executable regression remains at
`tests/integration/webttyAgentPtyLifecycle.test.mjs`, with its Box-side driver at
`tests/integration/webttyAgentPtyLifecycleDriver.mjs`.
