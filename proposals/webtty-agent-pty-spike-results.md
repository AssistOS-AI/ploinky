# WebTTY agent PTY lifecycle spike results

| Field | Value |
| --- | --- |
| Date | 2026-08-28 |
| Result | **Passed: controlled persistent `podman exec -it` under Box `node-pty` selected** |
| Production Box source | Ploinky `e73c3189652841362669d433a2c8f442ae59b269` |
| Production image definition | `container-image-builds` `1751b13705c5b6e6eb371c267f37dd4b8bcc184e` |
| Candidate image ID | `sha256:2470a215b6f647c15560cf39bb738e21484ba7fd8bbe8a28133f1df3f4c0b507` |
| Candidate OCI digest | `sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f` |
| Local-only tag | `localhost/ploinky-box-phase0-webtty:e73c3189-1751b137-20260828t1001c` |
| Pinned agent image | `docker.io/assistos/ploinky-node@sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03` |
| Selected backend | `controlled-podman-exec-persistent-session-under-box-node-pty` |

## Decision

An independent reproduction corrected the original spike setup and reran the
complete admission harness from a clean fixture:

1. The readiness command depended on `ps`, `id`, and `tr`, which are absent from
   the pinned agent image. The corrected command uses Bash builtins and
   `/proc/$$/stat`, and the harness requires a fresh post-spawn cryptographic
   challenge plus numeric fields that match independently observed process
   identity. Terminal echo and hostile startup hooks cannot satisfy it.
2. Nested rootless Podman could not reopen PID handles because the enclosing Box
   denied `open_by_handle_at`. The production Box now uses the exact Podman
   v6.0.1 default seccomp profile transformed to return `ENOTSUP` for
   `name_to_handle_at`. Nested Podman then uses its existing `/proc` start-time
   identity fallback. The profile removes access; it adds no privilege, bind,
   helper, broker, or runtime topology.
3. Rootless user namespaces make the Box-visible owner UID differ from the
   target-visible UID. The harness derives the latter from the exact process's
   `/proc/<pid>/uid_map` and requires it to match the readiness frame.

With those corrections, the controlled persistent CLI candidate passed every
mandatory Phase 0 admission and lifecycle gate. The REST candidate demonstrated
exact create/attach, echo-resistant I/O, resize, attach-socket close, and exact
exec removal. It remains unselected because it was intentionally only a
viability probe and was not run through the full lifecycle matrix.

The narrower CLI `--no-session` alternative was also investigated. It avoided a
persistent exec record, but resize did not propagate: after resizing the outer
PTY to 101 by 33, the inner shell still reported `0 0`. It is rejected and the
harness fails closed if it ever completes unexpectedly.

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
| `ploinky-box/seccomp/podman-nested-pid-fallback.json` | `4a226832feffda3ad82f745b0595cdd23f65a6203041ba5b4487cda43e838f99` |

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
automatic identity label was rejected before admission and removed.

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

## Selected candidate: persistent CLI under Box `node-pty`

The server-owned launch shape uses the full immutable container ID and a fixed
shell argv:

```text
/usr/bin/podman container exec --interactive --tty
  --user <0:0-or-1000:1000>
  --workdir <server-translated-container-cwd>
  --env PLOINKY_WEBTTY_MARKER=<server-random-marker>
  --env TERM=xterm-256color
  <full-container-id>
  /bin/bash --noprofile --norc -p -c
  '/bin/bash --noprofile --norc; status=$?;
   case "$status" in 126|127) exit 124 ;; *) exit "$status" ;; esac'
  ploinky-webtty-marker:<server-random-marker>
```

Before accepting browser traffic, the harness requires all of the following:

1. The Box-side Podman client PID, process group, session, foreground process
   group, controlling TTY, UID, and `/proc` start token are captured.
2. Inspecting the exact container returns exactly one engine exec ID.
3. An exact-container PID-namespace scan finds exactly one live fixed wrapper
   whose final argv element carries the random marker. Identity never depends on
   target-readable environment bytes. The scan correlates Box PID, PID namespace,
   nested PID/process-group/session vectors, mapped inner UID, and start token.
4. Only after capturing the exact Box-side Podman client does the worker write a
   fresh server-owned challenge. The returned frame contains that challenge plus
   numeric PID, process-group, session, UID, and `/proc` start token. Every field
   must match independent process evidence, and the challenge is not persisted.
5. A separate application marker roundtrip and `stty size` observation prove
   bidirectional I/O and actual inner resize.

The final REST-first admission run passed 1 of 1 tests in 79 seconds with run ID
`wtty-323-8da5f55e2e`. Running REST first proves that its service/socket cleanup
does not make the subsequently selected CLI lifecycle pass.

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f \
PLOINKY_WEBTTY_AGENT_IMAGE=docker.io/assistos/ploinky-node@sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03 \
PLOINKY_WEBTTY_PHASE0_FIRST_CANDIDATE=rest \
PLOINKY_WEBTTY_PHASE0_CLI_EXEC_MODE=persistent-session \
node --test tests/integration/webttyAgentPtyLifecycle.test.mjs
```

The exact executed source SHA-256 values were
`7ede70b3e279a8c14477d2cd4a76c2b19814770ebd130fd773ec8a5e21b2f64a`
for the driver,
`b289941568bd05abaf748e0307ff1c428d3dd13f490651ef59dedad7cc116b83`
for the readiness builder, and
`dd7959f9a77668d44ad23ac508ec0dfd381e554c1c1d1a39126641813be1a197`
for the shared agent runtime.

The successful matrix covered root and non-root normal exit; root and non-root
controlled close; Box Podman-client loss; foreground descendants; exact target
stop/remove; same-name replacement; worker crash/recovery; and an orphan audit
after every close. Every case revalidated the immutable container and exec IDs
and ended with no marker process, client process, session member, or exec record.

## Rejected alternatives

### CLI `--no-session`

The same CLI matrix can be run with
`PLOINKY_WEBTTY_PHASE0_CLI_EXEC_MODE=no-session`. Exact identity, echo-resistant
I/O, and zero engine exec records were observed, but root-normal resize failed:
the required 101 by 33 resize left the inner `stty size` value at `0 0` until
the deadline. The run failed rather than weakening or skipping resize.

### Local Podman REST exec

The harness created a mode-0700 service directory and unique Unix socket,
verified `/_ping` and `/version`, created an exec against the full immutable
container ID, and attached the returned 64-hex exec ID through a 101 Upgrade.
The corrected echo-resistant numeric readiness frame, independent marker
identity, application I/O, and a 97 by 29 inner resize all succeeded.

After the upgraded attach socket closed, the exact exec still reported
`Running: true`; exact removal through
`POST /v5.0.0/libpod/exec/<id>/remove` then succeeded and the exec became absent.
The executable evidence records `viabilityProbePassed: true` and
`fullPhase0Admission: false`. The full REST lifecycle matrix was not run or
credited, so REST cannot displace the fully admitted CLI candidate.

## Matrix disposition

| Required case | Persistent CLI/node-pty | REST |
| --- | --- | --- |
| Exact image/runtime inventory | Passed | Passed |
| Immutable container and exec identity | Passed | Passed for create/attach |
| Marker present in exact inner process | Passed | Passed in viability probe |
| Echo-resistant bidirectional I/O | Passed | Passed in viability probe |
| Resize verified by inner `stty size` | Passed | Passed in viability probe |
| Root and non-root normal close | Passed | Not admitted beyond viability probe |
| Box client death/reclaim | Passed | Not applicable; attach/service lifecycle not admitted |
| Foreground-child cleanup | Passed | Not admitted |
| Target stop/remove and same-name replacement | Passed | Not admitted |
| Worker crash/recovery | Passed | Not admitted |
| Orphan audit after every close | Passed | Passed after exact viability-probe removal |

The unexecuted REST rows are outside the deliberately limited viability probe;
they are not skips reported as success.

## Production worker and default-recovery evidence

The production `AgentTerminalWorker`, client, durable store, and default restart
recovery path passed the real pinned-image lifecycle test 1 of 1 with run ID
`prod_322_94420b10e7`. Its six clean fixtures proved normal non-root application
I/O and resize, controlled cleanup, crash recovery from both `pty-starting` and
`pty-ready`, foreign-exec isolation and self-heal, foreground-descendant cleanup,
stop plus force-remove recovery, and Bash-absence `/bin/sh` fallback. The
fallback fixture proves Bash absent before the first terminal exec.

The final rerun also corrected and proved default restart recovery after exact
target removal. Nested `podman container inspect` returns status 125, the exact
immutable-ID absence message on stderr, and the JSON empty array `[]` on stdout.
The production classifier now validates those streams separately and rejects
any additional stdout or prefixed/suffixed stderr. Its executed source SHA-256
values were
`a483409d83baffbb50ffd74132651c8bf1d1335f2e9126767a35e5c7c5cf855b`
(driver),
`cc359634256c862d558ab3b694759bc43ee41ebadfdc46aa6308ff6c3b790f42`
(worker),
`dd7959f9a77668d44ad23ac508ec0dfd381e554c1c1d1a39126641813be1a197`
(runtime), and
`f57ac9ca49570c8124a95456c0d467b30038d7895e9b2d29417ad20fab49dc14`
(durable records).

The production evidence ended with zero labeled containers, recovery records,
exact workers, exact Podman clients, marker processes, and exec records.

## Seccomp fallback evidence

The committed profile is byte-for-byte the Podman v6.0.1 default seccomp JSON
after removing `name_to_handle_at` from the allow list and adding an exact
`SCMP_ACT_ERRNO` rule returning errno 95 (`ENOTSUP`) for that syscall. Its SHA-256
is `4a226832feffda3ad82f745b0595cdd23f65a6203041ba5b4487cda43e838f99`.

The outer Box container receives it through a fixed absolute `seccomp=` security
option. Discovery and adoption require that exact option and the exact profile
digest label. This proves the intended behavior for the pinned Podman v6.0.1
profile provenance; broader native-Linux compatibility remains subject to the
repository's native deployment matrix.

## Cleanup proof

Every run used a random `io.assistos.ploinky.phase0=<run-id>` label, unique inner
container names, a unique REST socket directory, and a unique outer Box fixture
root. After each run the exact Box was removed and the host was audited.

The final Phase 0 audit found:

- zero host containers with an `io.assistos.ploinky.phase0` label;
- zero Phase 0 networks or volumes;
- zero retained Box fixture roots or REST service/socket directories;
- zero Phase 0 service processes or listeners;
- only the pinned local-only candidate image retained for later fresh-deployment
  testing;
- the shared Podman machine still running and never restarted.

The executable regression remains at
`tests/integration/webttyAgentPtyLifecycle.test.mjs`, with its Box-side driver at
`tests/integration/webttyAgentPtyLifecycleDriver.mjs` and its echo-resistant
frame builder at `tests/integration/webttyAgentPtyReadiness.mjs`.
