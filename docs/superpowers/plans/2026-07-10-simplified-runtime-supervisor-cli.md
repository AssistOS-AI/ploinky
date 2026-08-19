# Simplified Runtime Supervisor and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public box-command namespace with one automatically managed outer runtime, make parameterless ploinky cli open that runtime's Bash shell, preserve agent CLI behavior, and reconcile versioned runtime images without losing volumes or creation settings.

**Architecture:** The container-image-builds repository publishes a runtime-only, contract-labeled outer image first. Ploinky then uses a public-only host supervisor with an injected engine client and pure inspect/config planning, while core Ploinky owns the arity-based cli command, REPL terminal handoff, and layer banners. State commands bypass reconciliation; ordinary commands use transactional reconciliation with rollback.

**Tech Stack:** Node.js 20+ ES modules, Bash, Podman and Docker CLIs, Node test runner, GitHub Actions, Docker Buildx, HTML/Markdown documentation.

## Global Constraints

- Required outer image: docker.io/assistos/ploinky-box:podman-node24-runtime-v1.
- Required image label: io.assistos.ploinky.runtime-contract=1.
- The outer image contains Bash, Node 24, npm/npx, Git, slirp4netns, and functional rootless nested Podman; it contains no baked Ploinky source or Ploinky dependencies.
- images/ploinky-node remains free of Podman, Docker CLI, Docker Engine, and Moby CLI packages.
- Existing container and volume names remain ploinky-box-<instance>, ploinky-box-<instance>-workspace, ploinky-box-<instance>-containers, and ploinky-box-<instance>-ploinky-deps.
- Parameterless cli opens /bin/bash as the outer runtime's podman user in /workspace only when both the managed-runtime marker and an interactive terminal are present.
- cli <agent> [args...] retains lookup, auto-enable, readiness, runtime selection, PLOINKY_NO_TTY behavior, and manifest command construction.
- status is read-only: it must not pull, create, start, stop, remove, or reconcile.
- stop and destroy do not reconcile. stop always attempts the outer stop after core shutdown fails. destroy is the only automatic path allowed to remove the three named volumes.
- Omitted creation flags preserve compatible inspected settings. Explicit --port, --publish, --image, --mount, and --listen-lan values change the desired creation configuration.
- When --publish is omitted, preserve inspected extra publishes. When one or more --publish values are present, replace the prior extra-publish set with exactly those values before graph-derived publishes are merged.
- A compatible custom image is preserved when --image is omitted. A legacy official mutable reference migrates to the required image. Any other incompatible custom reference remains the selected desired reference, is force-pulled and contract-validated before mutation, and fails without altering the old runtime if it still lacks contract 1.
- A replacement image is pulled and contract-validated before the current runtime is stopped or removed.
- Reconciliation never removes workspace, dependency, or nested-container-storage volumes. Failed replacement creation or health validation reconstructs the prior image and prior normalized configuration.
- Help renders without engine detection, runtime startup, dependency installation, initEnvironment, or bootstrap.
- The public ploinky box namespace, container/ploinky-box executable, dual public/private mode, BOX_COMMANDS, runBoxCommand, and compatibility-only handlers/tests are deleted. Historical files under docs/superpowers remain unchanged.
- Preserve the current graph-driven publish work in container/box-publish-planner.mjs, container/publish-spec.mjs, its tests, and overlapping dirty files. Before execution, either commit that work as the branch baseline or transfer it verbatim into an isolated worktree and prove its focused tests still pass. Never stash, discard, or overwrite it.
- The container image is published and independently verified before the Ploinky adoption commit is merged. Workflow dispatch, registry publication, and Docker Hub configuration remain explicit operator actions.
- Add no runtime npm dependency. Use Node built-ins and the existing command/test infrastructure.

---

## Repository and File Structure

| Path | Responsibility after this plan |
| --- | --- |
| container-image-builds/images/ploinky-box/Dockerfile | Runtime-only outer image and exact contract label |
| container-image-builds/images/ploinky-box/entrypoint.sh | Hard runtime/mount/device/Podman self-check |
| container-image-builds/.github/workflows/publish-ploinky-box-image.yml | Immutable multi-architecture publication and mandatory nested-Podman gate |
| container-image-builds/tests/image-definitions.test.mjs | Static image/workflow contract and agent-image privilege boundary |
| ploinky/bin/ploinky | Runtime marker recursion guard and direct host-supervisor delegation |
| ploinky/bin/p-cli | Unchanged alias to bin/ploinky |
| ploinky/cli/services/runtimeShell.js | Managed outer-Bash validation and terminal execution |
| ploinky/cli/services/layerIdentification.js | Exact outer-runtime and agent-attachment banner formatting |
| ploinky/cli/services/inputState.js | Single-owner REPL terminal suspension/restoration |
| ploinky/cli/commands/cli.js | Arity-based cli dispatch |
| ploinky/cli/services/workspaceUtil.js | Existing agent CLI flow plus post-readiness layer banner |
| ploinky/cli/services/help.js | Host/core-aware help copy |
| ploinky/cli/index.js | Lightweight dependency-free launcher for help, direct parameterless-cli, and lazy core loading |
| ploinky/cli/main.js | Existing dependency-gated one-shot and interactive REPL implementation |
| ploinky/container/runtime-engine.mjs | Injectable Podman/Docker command client |
| ploinky/container/runtime-contract.mjs | Exact contract constants, inspect normalization, desired config, diff, and reconciliation plan |
| ploinky/container/runtime-supervisor.mjs | Public-only parsing, lifecycle orchestration, forwarding, graph-aware start, status, stop, destroy, and rollback |
| ploinky/tests/helpers/runtimeSupervisorHarness.mjs | Stateful fake engine and supervisor dependency harness |
| ploinky/container/runtime-supervisor-tests.mjs | Process-level launcher/routing and focused integration tests |
| ploinky/tests/unit/runtimeSupervisor.test.mjs | Unit-discovery shim for runtime-supervisor-tests.mjs |
| ploinky/container/smoke-runtime.mjs | Real public-entrypoint smoke test; no compatibility executable |

## Execution Preconditions

Run these before Task 1 and record the output in the implementation log:

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
git status --short
node --test tests/unit/ploinkyBoxWrapper.test.mjs tests/unit/boxPublishPlanner.test.mjs

cd /Users/danielsava/work/file-parser/container-image-builds
git status --short
node --test tests/image-definitions.test.mjs
~~~

Expected baseline: the Ploinky graph/wrapper tests pass while the listed dirty graph changes remain present, and container-image-builds is clean with 11 image-definition tests passing. If execution uses a worktree, invoke superpowers:using-git-worktrees only after the dirty Ploinky baseline has been preserved.

### Task 1: Build the runtime-only image under contract v1

**Files:**

- Modify: container-image-builds/tests/image-definitions.test.mjs
- Modify: container-image-builds/images/ploinky-box/Dockerfile
- Modify: container-image-builds/images/ploinky-box/entrypoint.sh

**Interfaces:**

- Consumes: the current Podman stable base, Node 24 multi-stage copy, podman user, and mounted-source convention.
- Produces: an image with Config.Labels["io.assistos.ploinky.runtime-contract"] equal to "1", an empty /opt/ploinky mountpoint, /etc/ploinky-box owned by the image, and an entrypoint that exits nonzero on every failed runtime prerequisite.

- [ ] **Step 1: Replace the old baked-image assertions with failing contract tests**

Replace the current ploinky-box test and add the ploinky-node negative guard:

~~~js
test('ploinky-box image is runtime-only contract v1', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const entrypoint = read('images/ploinky-box/entrypoint.sh');

    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.runtime-contract="1"$/m);
    assert.match(dockerfile, /mkdir -p \/opt\/ploinky \/workspace/);
    assert.match(dockerfile, /echo 'assistos\/ploinky-box' > \/etc\/ploinky-box/);
    assert.match(dockerfile, /^USER podman$/m);
    assert.match(dockerfile, /^WORKDIR \/workspace$/m);
    assert.doesNotMatch(dockerfile, /COPY sources\/ploinky/);
    assert.doesNotMatch(dockerfile, /npm install/);

    for (const command of ['bash', 'node', 'npm', 'git', 'podman']) {
        assert.match(entrypoint, new RegExp('command -v ' + command));
    }
    assert.match(entrypoint, /test -x \/opt\/ploinky\/bin\/ploinky/);
    assert.match(entrypoint, /test -d \/opt\/ploinky\/node_modules/);
    assert.match(entrypoint, /test -e \/dev\/fuse/);
    assert.match(entrypoint, /test -e \/dev\/net\/tun/);
    assert.match(entrypoint, /podman info/);
    assert.doesNotMatch(entrypoint, /achillesAgentLib/);
    assert.doesNotMatch(entrypoint, /mcp-sdk/);
});

test('ploinky-node does not install a container engine or client', () => {
    const dockerfile = read('images/ploinky-node/Dockerfile');
    assert.doesNotMatch(
        dockerfile,
        /\b(?:podman|docker-cli|docker-ce|docker-ce-cli|docker\.io|moby-engine|moby-cli)\b/i,
    );
});
~~~

- [ ] **Step 2: Run the image-definition test and verify the intended red state**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
node --test tests/image-definitions.test.mjs
~~~

Expected: FAIL because the Dockerfile still copies sources/ploinky, runs npm install, lacks the contract label, and the entrypoint lacks the Bash/npm checks while requiring baked dependencies. The ploinky-node negative guard passes.

- [ ] **Step 3: Replace the Dockerfile and entrypoint with the runtime-only contract**

Use this complete Dockerfile:

~~~dockerfile
ARG PODMAN_BASE=quay.io/podman/stable
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM $NODE_RUNTIME_IMAGE AS node-runtime

FROM $PODMAN_BASE

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git slirp4netns \
    && dnf clean all

LABEL io.assistos.ploinky.runtime-contract="1"

RUN mkdir -p /opt/ploinky /workspace /home/podman/.local/share/containers \
    && chown -R podman:podman /workspace /home/podman/.local/share/containers \
    && echo 'assistos/ploinky-box' > /etc/ploinky-box

ENV PATH=/opt/ploinky/bin:$PATH \
    PLOINKY_WORKSPACE_ROOT=/workspace

COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
~~~

Use this complete entrypoint:

~~~bash
#!/usr/bin/env bash
set -u

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

command -v bash >/dev/null 2>&1 || fail "bash not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
test -f /etc/ploinky-box || fail "/etc/ploinky-box marker missing"
test -x /opt/ploinky/bin/ploinky || fail "ploinky source not mounted read-only at /opt/ploinky"
test -d /opt/ploinky/node_modules || fail "dependency volume not mounted at /opt/ploinky/node_modules"
test -w /workspace || fail "/workspace not writable"
test -e /dev/fuse || fail "/dev/fuse not present"
test -e /dev/net/tun || fail "/dev/net/tun not present"
podman info >/dev/null 2>&1 || fail "inner podman not functional"

podman rm -af --time 0 >/dev/null 2>&1 || true
echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
~~~

- [ ] **Step 4: Run syntax and contract tests**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
bash -n images/ploinky-box/entrypoint.sh
node --test tests/image-definitions.test.mjs
~~~

Expected: Bash syntax exits 0 and all image-definition tests pass.

- [ ] **Step 5: Commit the image-content contract**

~~~bash
git add tests/image-definitions.test.mjs images/ploinky-box/Dockerfile images/ploinky-box/entrypoint.sh
git commit -m "feat: make ploinky-box runtime-only contract v1"
~~~

### Task 2: Publish the immutable generation with mandatory nested Podman

**Files:**

- Modify: container-image-builds/tests/image-definitions.test.mjs
- Modify: container-image-builds/.github/workflows/publish-ploinky-box-image.yml
- Modify: container-image-builds/README.md

**Interfaces:**

- Consumes: the contract-v1 image from Task 1 and a Ploinky source checkout used only as a verification bind mount.
- Produces: one protected publication target, assistos/ploinky-box:podman-node24-runtime-v1, plus required runtime-only, label, entrypoint, multi-architecture, and nested-container verification.

- [ ] **Step 1: Add failing workflow-policy assertions**

Add this separate workflow-policy test:

~~~js
test('ploinky-box workflow publishes immutable runtime v1 after required checks', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    assert.match(workflow, /IMAGE_TAG:\s*podman-node24-runtime-v1/);
    assert.doesNotMatch(workflow, /^\s+image_tag:/m);
    assert.match(workflow, /Verify immutable tag is unused/);
    assert.match(workflow, /case "\$status" in/);
    assert.match(workflow, /404\)/);
    assert.match(workflow, /200\)/);
    assert.match(workflow, /unexpected registry status/);
    assert.doesNotMatch(
        workflow,
        /imagetools inspect[^\n]*>[\/]dev\/null 2>&1/,
    );
    assert.match(workflow, /io\.assistos\.ploinky\.runtime-contract/);
    assert.match(workflow, /podman version/);
    assert.match(workflow, /podman info/);
    assert.match(workflow, /nested-ok/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);

    const nestedStep = workflow.match(
        /- name: Nested podman contract check[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';
    assert.ok(nestedStep);
    assert.doesNotMatch(nestedStep, /continue-on-error:\s*true/);
});
~~~

- [ ] **Step 2: Run the test and verify the policy failures**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
node --test tests/image-definitions.test.mjs
~~~

Expected: FAIL because the workflow accepts image_tag, defaults to podman-node24, lacks an immutable-tag guard and label inspection, and marks nested Podman best-effort.

- [ ] **Step 3: Replace the workflow inputs, tag policy, and verification steps**

Keep the existing checkout, QEMU, Buildx, login, verification build, and final multi-architecture build actions. Replace the workflow input/tag declarations with:

~~~yaml
on:
  workflow_dispatch:
    inputs:
      source_ref:
        description: AssistOS-AI/ploinky ref mounted during verification
        required: false
        default: master
        type: string

env:
  IMAGE_NAME: assistos/ploinky-box
  IMAGE_TAG: podman-node24-runtime-v1
~~~

After Docker Hub login, add this fail-closed Registry API gate. Only an authenticated 404 means the tag is unused; auth, rate-limit, server, and network failures abort publication:

~~~yaml
      - name: Verify immutable tag is unused
        run: |
          token=$(curl --fail --silent --show-error --get \
            --data-urlencode service=registry.docker.io \
            --data-urlencode scope="repository:$IMAGE_NAME:pull" \
            https://auth.docker.io/token | jq -er '.token')
          body=$(mktemp)
          trap 'rm -f "$body"' EXIT
          if ! status=$(curl --silent --show-error \
            --output "$body" \
            --write-out '%{http_code}' \
            --head \
            --header "Authorization: Bearer $token" \
            --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
            "https://registry-1.docker.io/v2/$IMAGE_NAME/manifests/$IMAGE_TAG"); then
            echo "Registry query failed; refusing to publish $IMAGE_NAME:$IMAGE_TAG" >&2
            cat "$body" >&2
            exit 1
          fi
          case "$status" in
            404)
              echo "Immutable tag is unused: $IMAGE_NAME:$IMAGE_TAG"
              ;;
            200)
              echo "Refusing to overwrite immutable runtime tag $IMAGE_NAME:$IMAGE_TAG" >&2
              exit 1
              ;;
            *)
              echo "Refusing to publish after unexpected registry status $status" >&2
              cat "$body" >&2
              exit 1
              ;;
          esac
~~~

Replace image-content verification with:

~~~yaml
      - name: Verify runtime-only image contract
        run: |
          contract=$(docker image inspect \
            --format '{{ index .Config.Labels "io.assistos.ploinky.runtime-contract" }}' \
            ploinky-box:verify)
          test "$contract" = "1"
          docker run --rm --entrypoint bash ploinky-box:verify -lc '
            set -e
            command -v bash
            node -v
            npm -v
            git --version
            podman --version
            test -f /etc/ploinky-box
            test -z "$(ls -A /opt/ploinky)"
            echo IMAGE-OK
          '
~~~

Add the complete entrypoint self-check step:

~~~yaml
      - name: Verify ploinky-box entrypoint self-check
        run: |
          deps_volume="ploinky-box-entrypoint-deps-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
          container_name="ploinky-box-entrypoint-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
          docker rm -f "$container_name" >/dev/null 2>&1 || true
          docker volume rm -f "$deps_volume" >/dev/null 2>&1 || true
          docker volume create "$deps_volume"
          trap 'docker rm -f "$container_name" >/dev/null 2>&1 || true; docker volume rm -f "$deps_volume" >/dev/null 2>&1 || true' EXIT
          docker run --rm --user root --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc 'chown podman:podman /opt/ploinky/node_modules'
          docker run -d --name "$container_name" --user podman \
            --device /dev/fuse \
            --device /dev/net/tun \
            --security-opt seccomp=unconfined \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify
          for attempt in $(seq 1 30); do
            if docker logs "$container_name" 2>&1 | grep -q 'self-check OK'; then
              break
            fi
            sleep 1
          done
          docker logs "$container_name" 2>&1 | grep -q 'self-check OK'
~~~

Add the complete mounted-source/dependency step:

~~~yaml
      - name: Verify mounted Ploinky source and dependency volume
        run: |
          deps_volume="ploinky-box-source-deps-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
          docker volume rm -f "$deps_volume" >/dev/null 2>&1 || true
          docker volume create "$deps_volume"
          trap 'docker volume rm -f "$deps_volume" >/dev/null 2>&1 || true' EXIT
          docker run --rm --user root --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc 'chown podman:podman /opt/ploinky/node_modules'
          docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc 'ploinky help >/dev/null'
          set +e
          output=$(docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc 'ploinky list agents' 2>&1)
          code=$?
          set -e
          echo "$output"
          test "$code" -ne 0
          echo "$output" | grep -q 'Ploinky cannot run until dependencies are installed'
          docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc '/opt/ploinky/bin/ploinky-install-deps'
          docker run --rm --user podman --entrypoint bash \
            -v "$PWD/sources/ploinky:/opt/ploinky:ro" \
            -v "$deps_volume:/opt/ploinky/node_modules" \
            ploinky-box:verify -lc '
              set -e
              test -d /opt/ploinky/node_modules/achillesAgentLib
              test -d /opt/ploinky/node_modules/mcp-sdk
              ploinky help >/dev/null
              ploinky list agents >/dev/null
              echo MOUNT-OK
            '
~~~

Replace the nested step with:

~~~yaml
      - name: Nested podman contract check
        run: |
          docker run --rm --user podman \
            --device /dev/fuse \
            --device /dev/net/tun \
            --security-opt seccomp=unconfined \
            --security-opt label=disable \
            --volume "$PWD/sources/ploinky:/opt/ploinky:ro" \
            --volume /opt/ploinky/node_modules \
            ploinky-box:verify \
            bash -lc '
              set -e
              podman version
              podman info
              podman run --network slirp4netns:allow_host_loopback=true \
                --rm docker.io/library/alpine echo nested-ok
            '
~~~

Make metadata publish exactly the immutable tag:

~~~yaml
      - name: Build metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: assistos/ploinky-box
          tags: type=raw,value=podman-node24-runtime-v1
~~~

- [ ] **Step 4: Update the image catalog and manual release command**

In README.md, make the ploinky-box row say it is runtime-only, mounts Ploinky source and dependencies, and has contract 1. Replace the mutable example with:

~~~bash
gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=ploinky-box
~~~

State directly below it that podman-node24-runtime-v1 is immutable and a future incompatible generation must use runtime-v2 plus contract value 2.

- [ ] **Step 5: Run local workflow and documentation checks**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
bash -n images/ploinky-box/entrypoint.sh
node --test tests/image-definitions.test.mjs
if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/publish-ploinky-box-image.yml
else
  echo "actionlint unavailable; GitHub Actions syntax remains a release gate"
fi
~~~

Expected: Bash and Node tests pass. If actionlint exists it exits 0; otherwise the explicit informational line is printed.

- [ ] **Step 6: Commit publication policy**

~~~bash
git add tests/image-definitions.test.mjs .github/workflows/publish-ploinky-box-image.yml README.md
git commit -m "ci: publish immutable ploinky runtime v1"
~~~

### Manual Gate A: Publish and verify runtime v1

This gate is deliberately not an automatic implementation action.

- [ ] Merge or otherwise make Tasks 1-2 available to the release workflow.
- [ ] Ensure source_ref points to a Ploinky branch containing the host-mounted source contract and bin/ploinky-install-deps. At the time this plan was written, that branch is ploinky-box.
- [ ] In Docker Hub repository settings, enable or verify an immutable-tag policy that covers podman-node24-runtime-v1; record the setting together with the workflow run.
- [ ] Dispatch publish-ploinky-box-image.yml and require IMAGE-OK, self-check OK, podman version, podman info, and nested-ok.
- [ ] Verify docker.io/assistos/ploinky-box:podman-node24-runtime-v1 contains linux/amd64 and linux/arm64 with docker buildx imagetools inspect.
- [ ] Pull the published image independently and verify its label equals 1.
- [ ] Do not merge the Ploinky adoption task until every gate item succeeds.

### Task 3: Add the managed outer-runtime shell primitive

**Files:**

- Create: ploinky/cli/services/layerIdentification.js
- Create: ploinky/cli/services/runtimeShell.js
- Create: ploinky/tests/unit/runtimeShell.test.mjs

**Interfaces:**

- Consumes: isPloinkyBoxRuntime(markerPath), inputState.prepareForExternalCommand(), process streams, and spawnSync.
- Produces: formatOuterRuntimeBanner(identity) returning two strings, validateOuterRuntimeShell(context) throwing stable user errors, and runOuterRuntimeShell(dependencies) returning the Bash exit status.

- [ ] **Step 1: Write the failing managed-context, TTY, banner, spawn, and restore tests**

Use dependency injection so the test never opens a real shell:

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOuterRuntimeShell } from '../../cli/services/runtimeShell.js';

test('outer shell validates marker before tty and restores around bash', () => {
    const events = [];
    const lines = [];
    const code = runOuterRuntimeShell({
        env: { TOKEN: 'kept' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        markerPath: '/marker',
        isManagedRuntimeImpl: value => value === '/marker',
        runtimeName: 'ploinky-box-demo',
        user: 'podman',
        log: line => lines.push(line),
        prepareForExternalCommandImpl: options => {
            events.push(['suspend', options]);
            return () => events.push('restore');
        },
        spawnSyncImpl: (file, args, options) => {
            events.push({ file, args, options });
            return { status: 0 };
        },
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
        "[ploinky] Entering outer runtime 'ploinky-box-demo'",
        '[ploinky] user=podman cwd=/workspace; exit returns to the previous prompt',
    ]);
    assert.deepEqual(events[0], ['suspend', { promptOnRestore: false }]);
    assert.deepEqual(events[1], {
        file: '/bin/bash',
        args: [],
        options: { cwd: '/workspace', stdio: 'inherit', env: { TOKEN: 'kept' } },
    });
    assert.equal(events[2], 'restore');
});

test('outer shell rejects direct core execution before checking tty', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: false },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => false,
        }),
        /requires the managed Ploinky runtime/,
    );
});

test('outer shell requires both interactive streams', () => {
    assert.throws(
        () => runOuterRuntimeShell({
            stdin: { isTTY: true },
            stdout: { isTTY: false },
            isManagedRuntimeImpl: () => true,
        }),
        /requires an interactive terminal/,
    );
});
~~~

- [ ] **Step 2: Run the focused test and verify module-not-found**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/runtimeShell.test.mjs
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for cli/services/runtimeShell.js.

- [ ] **Step 3: Implement the banner and shell runner**

Create layerIdentification.js:

~~~js
export function formatOuterRuntimeBanner({ runtimeName, user, cwd = '/workspace' }) {
    return [
        "[ploinky] Entering outer runtime '" + runtimeName + "'",
        '[ploinky] user=' + user + ' cwd=' + cwd + '; exit returns to the previous prompt',
    ];
}
~~~

Create runtimeShell.js:

~~~js
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isPloinkyBoxRuntime } from './docker/common.js';
import * as inputState from './inputState.js';
import { formatOuterRuntimeBanner } from './layerIdentification.js';

const MANAGED_ERROR =
    "cli: parameterless 'cli' requires the managed Ploinky runtime. "
    + "Run it through the host 'ploinky cli' command.";
const TTY_ERROR = "cli: parameterless 'cli' requires an interactive terminal.";

export function validateOuterRuntimeShell({
    markerPath = '/etc/ploinky-box',
    stdin = process.stdin,
    stdout = process.stdout,
    isManagedRuntimeImpl = isPloinkyBoxRuntime,
} = {}) {
    if (!isManagedRuntimeImpl(markerPath)) throw new Error(MANAGED_ERROR);
    if (!stdin.isTTY || !stdout.isTTY) throw new Error(TTY_ERROR);
}

export function runOuterRuntimeShell({
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    markerPath = '/etc/ploinky-box',
    spawnSyncImpl = spawnSync,
    prepareForExternalCommandImpl = inputState.prepareForExternalCommand,
    isManagedRuntimeImpl = isPloinkyBoxRuntime,
    runtimeName = env.PLOINKY_RUNTIME_NAME || os.hostname(),
    user = os.userInfo().username,
    log = console.log,
} = {}) {
    validateOuterRuntimeShell({ markerPath, stdin, stdout, isManagedRuntimeImpl });
    for (const line of formatOuterRuntimeBanner({ runtimeName, user })) log(line);
    const restore = prepareForExternalCommandImpl({ promptOnRestore: false })
        || (() => {});
    try {
        const result = spawnSyncImpl('/bin/bash', [], {
            cwd: '/workspace',
            stdio: 'inherit',
            env,
        });
        if (result.error) throw result.error;
        return Number.isInteger(result.status) ? result.status : 1;
    } finally {
        restore();
    }
}
~~~

- [ ] **Step 4: Run the runtime-shell tests**

Run:

~~~bash
node --test tests/unit/runtimeShell.test.mjs
~~~

Expected: all runtime-shell tests pass.

- [ ] **Step 5: Commit the primitive**

~~~bash
git add cli/services/layerIdentification.js cli/services/runtimeShell.js tests/unit/runtimeShell.test.mjs
git commit -m "feat: add managed outer runtime shell"
~~~

### Task 4: Dispatch cli by arity and restore one REPL prompt

**Files:**

- Modify: ploinky/bin/ploinky
- Modify: ploinky/cli/commands/cli.js
- Modify: ploinky/cli/index.js
- Create: ploinky/cli/main.js
- Modify: ploinky/cli/services/inputState.js
- Create: ploinky/cli/services/replCommandRunner.js
- Create: ploinky/tests/fixtures/lightweightCliBoundaryLoader.mjs
- Create: ploinky/tests/unit/inputState.test.mjs
- Modify: ploinky/tests/unit/cliExitCodes.test.mjs
- Modify: ploinky/tests/unit/runtimeShell.test.mjs

**Interfaces:**

- Consumes: runOuterRuntimeShell() from Task 3 and existing runCli(agentName, args).
- Produces: handleCliCommand(options, dependencies) returning a Bash status or the agent CLI result; prepareForExternalCommand({promptOnRestore:false}) returning an idempotent restore function; runReplCommand(context) retaining history and giving prompt ownership to the REPL caller; launchCli(args, dependencies) as an install-free lightweight launcher; and runCoreCli(args) as the lazily loaded dependency-gated CLI/REPL entry.

- [ ] **Step 1: Add failing arity and input-state tests**

Export handleCliCommand and test it directly:

~~~js
import { handleCliCommand } from '../../cli/commands/cli.js';

test('cli dispatches solely by argument arity', async () => {
    const calls = [];
    const shellCode = await handleCliCommand([], {
        runOuterRuntimeShellImpl: () => {
            calls.push(['outer']);
            return 7;
        },
        runAgentCliImpl: async (...args) => calls.push(['agent', ...args]),
    });
    await handleCliCommand(['explorer', '--help'], {
        runOuterRuntimeShellImpl: () => calls.push(['wrong']),
        runAgentCliImpl: async (...args) => calls.push(['agent', ...args]),
    });
    assert.equal(shellCode, 7);
    assert.deepEqual(calls, [
        ['outer'],
        ['agent', 'explorer', ['--help']],
    ]);
});
~~~

In inputState.test.mjs, register a fake readline and assert exact ownership:

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isSuspended,
    prepareForExternalCommand,
    registerInterface,
} from '../../cli/services/inputState.js';

test('external command restore is idempotent and does not print a prompt', () => {
    const events = [];
    const input = {
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        prompt: () => events.push('prompt'),
    };
    registerInterface(rl);
    const restore = prepareForExternalCommand({ promptOnRestore: false });
    assert.equal(isSuspended(), true);
    restore();
    restore();
    assert.equal(isSuspended(), false);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['raw', true],
        'resume',
    ]);
    registerInterface(null);
});
~~~

Add an integration-style REPL ownership test using the real input-state and runtime-shell functions with only Bash spawning injected:

~~~js
import { handleCliCommand } from '../../cli/commands/cli.js';
import { runReplCommand } from '../../cli/services/replCommandRunner.js';
import { runOuterRuntimeShell } from '../../cli/services/runtimeShell.js';

test('repl cli gives bash the tty then restores history and exactly one prompt', async () => {
    const events = [];
    const input = {
        isTTY: true,
        isRaw: true,
        setRawMode(value) {
            events.push(['raw', value]);
            this.isRaw = value;
        },
    };
    const rl = {
        input,
        history: ['status', 'list agents'],
        pause: () => events.push('pause'),
        resume: () => events.push('resume'),
        setPrompt: value => events.push(['setPrompt', value]),
        prompt: () => events.push('prompt'),
    };
    const historyBefore = [...rl.history];
    registerInterface(rl);
    await runReplCommand({
        args: ['cli'],
        rl,
        stdin: input,
        getPromptImpl: () => 'ploinky> ',
        handleCommandImpl: args => handleCliCommand(args.slice(1), {
            runOuterRuntimeShellImpl: () => runOuterRuntimeShell({
                stdin: input,
                stdout: { isTTY: true },
                isManagedRuntimeImpl: () => true,
                runtimeName: 'ploinky-box-demo',
                user: 'podman',
                log: () => {},
                spawnSyncImpl: (file, argv, options) => {
                    assert.equal(isSuspended(), true);
                    events.push(['spawn', file, argv, options.stdio]);
                    return { status: 0 };
                },
            }),
        }),
    });
    assert.deepEqual(rl.history, historyBefore);
    assert.deepEqual(events, [
        'pause',
        ['raw', false],
        ['spawn', '/bin/bash', [], 'inherit'],
        ['raw', true],
        'resume',
        ['setPrompt', 'ploinky> '],
        'prompt',
    ]);
    registerInterface(null);
});
~~~

Add these process tests, using the repository root already resolved by cliExitCodes.test.mjs. Define the deterministic loader path once near repoRoot:

~~~js
const lightweightBoundaryLoader = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'lightweightCliBoundaryLoader.mjs',
);
~~~

~~~js
test('direct-core bare cli fails before dependency initialization', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-empty-root-'));
    try {
        const result = spawnSync(
            process.execPath,
            [
                '--experimental-loader', lightweightBoundaryLoader,
                'cli/index.js', 'cli',
            ],
            {
                cwd: repoRoot,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            },
        );
        const output = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 1);
        assert.match(output, /requires the managed Ploinky runtime/);
        assert.doesNotMatch(output, /Ploinky dependencies missing/);
        assert.doesNotMatch(output, /FORBIDDEN_CORE_MODULE/);
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
});

test('help and direct-core bare cli do not load the core command graph', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-empty-root-'));
    try {
        for (const args of [['help'], ['--help'], ['-h']]) {
            const result = spawnSync(
                process.execPath,
                [
                    '--experimental-loader', lightweightBoundaryLoader,
                    'cli/index.js', ...args,
                ],
                {
                    cwd: repoRoot,
                    env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                    encoding: 'utf8',
                },
            );
            assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
        }

        const shell = spawnSync(
            process.execPath,
            [
                '--experimental-loader', lightweightBoundaryLoader,
                'cli/index.js', 'cli',
            ],
            {
                cwd: repoRoot,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            },
        );
        const output = (shell.stdout || '') + (shell.stderr || '');
        assert.equal(shell.status, 1);
        assert.match(output, /requires the managed Ploinky runtime/);
        assert.doesNotMatch(output, /FORBIDDEN_CORE_MODULE/);
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
});

test('managed launcher bypasses its dependency gate only for help and bare cli', () => {
    const launcher = fs.readFileSync(path.join(repoRoot, 'bin', 'ploinky'), 'utf8');
    assert.match(
        launcher,
        /case "\$\{1:-\}" in[\s\S]*help\|--help\|-h[\s\S]*cli[\s\S]*skip_dependency_gate=1/,
    );
    assert.ok(
        launcher.indexOf('skip_dependency_gate=1')
        < launcher.indexOf('deps_missing=0'),
    );
    assert.match(
        launcher,
        /cli\)[\s\S]{0,160}\[\[ "\$#" -eq 1 \]\] && skip_dependency_gate=1/,
    );
});
~~~

Create lightweightCliBoundaryLoader.mjs. It blocks resolved core entry/command modules, so the current eager cli/commands/cli.js import produces a real red result and any later regression to a static cli/main.js import is caught. It also replaces runtimeShell.js with a deterministic managed-runtime error for this subprocess only, so the test result cannot depend on whether the test host itself has /etc/ploinky-box or a TTY:

~~~js
const runtimeShellSource = `
export function runOuterRuntimeShell() {
    throw new Error(
        "cli: parameterless 'cli' requires the managed Ploinky runtime. "
        + "Run it through the host 'ploinky cli' command."
    );
}
`;
const runtimeShellStub =
    'data:text/javascript;charset=utf-8,' + encodeURIComponent(runtimeShellSource);

export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    const pathname = new URL(resolved.url).pathname;
    if (pathname.endsWith('/cli/services/runtimeShell.js')) {
        return { url: runtimeShellStub, shortCircuit: true };
    }
    if (/\/cli\/(?:main\.js|commands\/)/.test(pathname)) {
        throw new Error('FORBIDDEN_CORE_MODULE:' + pathname);
    }
    return resolved;
}
~~~

- [ ] **Step 2: Run the focused tests and verify current failures**

Run:

~~~bash
node --test tests/unit/inputState.test.mjs tests/unit/cliExitCodes.test.mjs tests/unit/runtimeShell.test.mjs
~~~

Expected: FAIL because handleCliCommand is missing, cli/index.js statically loads the core command graph before reaching help or bare cli, bare cli prints help after dependency checks, and prepareForExternalCommand invokes rl.prompt(). The loader reports FORBIDDEN_CORE_MODULE when the eager cli/commands/cli.js import resolves.

- [ ] **Step 3: Implement arity dispatch and prompt ownership**

In cli/commands/cli.js import runOuterRuntimeShell and add:

~~~js
export async function handleCliCommand(options = [], {
    runOuterRuntimeShellImpl = runOuterRuntimeShell,
    runAgentCliImpl = runCli,
} = {}) {
    if (options.length === 0) return runOuterRuntimeShellImpl();
    return runAgentCliImpl(options[0], options.slice(1));
}
~~~

Replace the cli switch branch with:

~~~js
case 'cli':
    return handleCliCommand(options);
~~~

Change inputState.js to:

~~~js
export function prepareForExternalCommand({ promptOnRestore = false } = {}) {
    const rl = activeInterface;
    if (!rl || !rl.input) return () => {};
    const inputStream = rl.input;
    let restored = false;
    const previousRawMode = typeof inputStream.setRawMode === 'function'
        ? Boolean(inputStream.isRaw)
        : null;

    suspend();
    if (typeof rl.pause === 'function') rl.pause();
    else if (typeof inputStream.pause === 'function') inputStream.pause();
    if (previousRawMode === true) inputStream.setRawMode(false);

    return () => {
        if (restored) return;
        restored = true;
        if (previousRawMode !== null) inputStream.setRawMode(previousRawMode);
        if (typeof rl.resume === 'function') rl.resume();
        else if (typeof inputStream.resume === 'function') inputStream.resume();
        resume();
        if (promptOnRestore && typeof rl.prompt === 'function') rl.prompt();
    };
}
~~~

Create replCommandRunner.js and use it from the `rl.on('line')` callback after the existing history append:

~~~js
export async function runReplCommand({
    args,
    rl,
    stdin = process.stdin,
    handleCommandImpl,
    getPromptImpl,
    onError = error => console.error('Error: ' + error.message),
}) {
    try {
        await handleCommandImpl(args);
    } catch (error) {
        onError(error);
    }
    rl.setPrompt(getPromptImpl());
    if (stdin.isTTY) rl.prompt();
}
~~~

The line callback remains responsible for exit/quit and writing `trimmedLine` to HISTORY_FILE, then calls runReplCommand once. Remove its second direct `rl.prompt()` call for nonempty commands; empty input still calls `rl.prompt()` directly.

In bin/ploinky, immediately after `export PLOINKY_ROOT="$ROOT_DIR"` and before `deps_missing=0`, add:

~~~bash
    skip_dependency_gate=0
    case "${1:-}" in
        help|--help|-h)
            skip_dependency_gate=1
            ;;
        cli)
            [[ "$#" -eq 1 ]] && skip_dependency_gate=1
            ;;
    esac
~~~

Wrap the existing dependency prompt/install block in `if [[ "$skip_dependency_gate" == "0" ]]; then ... fi`. Do not bypass the gate for `cli <agent>` or any ordinary command.

Move the current cli/index.js implementation, including completion, prompt, history, bootstrap, and REPL setup, into cli/main.js. Remove its executable-entrypoint guard and export this boundary:

~~~js
export async function runCoreCli(args = []) {
    assertRuntimeDependencies();
    logPloinkyDirectory();
    args = [...args];

    const debugIndex = args.findIndex(arg => arg === '--debug' || arg === '-d');
    if (debugIndex > -1) {
        setDebugMode(true);
        args.splice(debugIndex, 1);
        console.log('[INFO] Debug mode enabled.');
    }

    debugLog('Raw arguments:', args);
    initEnvironment();
    let startParsed;
    let branchPolicy;
    if (args.length && args[0] === 'start') {
        try {
            startParsed = parseStartArgs(args.slice(1));
            branchPolicy = startParsed.branchPolicy;
        } catch (_) {}
    }
    try {
        bootstrap({ branchPolicy, staticAgent: startParsed?.staticAgent });
    } catch (error) {
        if (branchPolicy?.fallback === 'fail') throw error;
    }

    if (args.length === 0) return startInteractiveMode();
    return handleCommand(args);
}
~~~

Do not retain a static import of cli/main.js, cli/commands/cli.js, or any other core command module in cli/index.js. Replace cli/index.js with a lightweight executable whose only static local imports are services/help.js and services/runtimeShell.js (plus Node built-ins used by its executable-entrypoint guard):

~~~js
#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showHelp } from './services/help.js';
import { runOuterRuntimeShell } from './services/runtimeShell.js';

export async function launchCli(args = process.argv.slice(2), {
    showHelpImpl = showHelp,
    runOuterRuntimeShellImpl = runOuterRuntimeShell,
    importCoreImpl = () => import('./main.js'),
} = {}) {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showHelpImpl(args[0] === 'help' ? args.slice(1) : [], { surface: 'core' });
        return 0;
    }
    if (args.length === 1 && args[0] === 'cli') {
        return runOuterRuntimeShellImpl();
    }
    const { runCoreCli } = await importCoreImpl();
    return runCoreCli(args);
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
    launchCli().then(code => {
        if (Number.isInteger(code)) process.exitCode = code;
    }).catch(error => {
        console.error('❌ Error: ' + error.message);
        process.exitCode = 1;
    });
}
~~~

The REPL line callback in cli/main.js continues to await handleCommand(args) and remains the sole caller of rl.prompt(). The ordinary one-shot path now returns the resolved handleCommand result to launchCli so numeric exit codes propagate without calling process.exit inside the command graph.

- [ ] **Step 4: Run the CLI and input-state regression set**

Run:

~~~bash
node --test \
  tests/unit/inputState.test.mjs \
  tests/unit/cliExitCodes.test.mjs \
  tests/unit/runtimeShell.test.mjs \
  tests/unit/containerRuntime.test.mjs
~~~

Expected: all selected tests pass; direct-core bare cli fails before dependency initialization; cli <agent> does not enter runtime-shell validation.

- [ ] **Step 5: Commit arity and terminal ownership**

~~~bash
git add bin/ploinky cli/commands/cli.js cli/index.js cli/main.js cli/services/inputState.js \
  cli/services/replCommandRunner.js \
  tests/fixtures/lightweightCliBoundaryLoader.mjs \
  tests/unit/inputState.test.mjs tests/unit/cliExitCodes.test.mjs tests/unit/runtimeShell.test.mjs
git commit -m "feat: dispatch cli by argument arity"
~~~

### Task 5: Identify agent attachments and make help layer-aware

**Files:**

- Modify: ploinky/cli/services/layerIdentification.js
- Modify: ploinky/cli/services/workspaceUtil.js
- Modify: ploinky/cli/services/help.js
- Modify: ploinky/cli/main.js
- Create: ploinky/tests/unit/layerIdentification.test.mjs
- Create: ploinky/tests/unit/helpLayers.test.mjs
- Modify: ploinky/tests/unit/agentReadiness.test.mjs

**Interfaces:**

- Consumes: the post-ensure registry map from loadAgentsMap(), the final containerName, actual runtime, and PLOINKY_NO_TTY.
- Produces: resolveAgentAttachmentIdentity(agentName, containerName, registry) and formatAgentAttachmentBanner(identity); runCliWithDependencies(agentName, args, dependencies) as a test seam over the unchanged agent flow; showHelp(args, {surface}) with surface equal to core or host.

- [ ] **Step 1: Write failing banner and help tests**

Use these exact formatter expectations:

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatAgentAttachmentBanner,
    resolveAgentAttachmentIdentity,
} from '../../cli/services/layerIdentification.js';

test('agent banner uses the post-start registry image', () => {
    const identity = resolveAgentAttachmentIdentity('explorer', 'nested-explorer', {
        'nested-explorer': {
            runtime: 'container',
            containerImage: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
        },
    });
    assert.deepEqual(formatAgentAttachmentBanner(identity), [
        "[ploinky] Attaching to agent 'explorer'",
        '[ploinky] container=nested-explorer',
        '[ploinky] image=docker.io/assistos/ploinky-node:24-bookworm-tools',
    ]);
});

test('host sandbox attachments identify the selected host runtime', () => {
    const identity = resolveAgentAttachmentIdentity('local-agent', 'local-agent', {
        'local-agent': { runtime: 'bwrap' },
    });
    assert.equal(identity.image, 'host (bwrap)');
});
~~~

In agentReadiness.test.mjs, exercise the complete container attachment path rather than only the formatter:

~~~js
import { runCliWithDependencies } from '../../cli/services/workspaceUtil.js';

function agentCliHarness({ noTTY = false } = {}) {
    const events = [];
    const logs = [];
    let enabled = false;
    const record = {
        containerName: 'nested-explorer',
        record: {
            repoName: 'AssistOSExplorer',
            agentName: 'explorer',
        },
    };
    return {
        events,
        logs,
        dependencies: {
            env: noTTY ? { PLOINKY_NO_TTY: '1' } : {},
            resolveEnabledAgentRecord: () => enabled ? record : null,
            findAgent: () => ({
                repo: 'AssistOSExplorer',
                manifestPath: '/fixtures/AssistOSExplorer/explorer/manifest.json',
                shortAgentName: 'explorer',
            }),
            enableAgent: reference => {
                events.push(['enable', reference]);
                enabled = true;
            },
            readManifest: () => ({
                cli: '/Agent/default_cli.sh',
                readiness: { protocol: 'mcp' },
            }),
            ensureAgentService: () => {
                events.push(['ensure']);
                return { containerName: 'nested-explorer', hostPort: 15517 };
            },
            waitForAgentReady: async () => {
                events.push(['ready']);
                return true;
            },
            loadAgentsMap: () => ({
                'nested-explorer': {
                    runtime: 'container',
                    containerImage: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
                },
            }),
            attachInteractive: (containerName, projectPath, command) => {
                events.push(['attach', containerName, projectPath, command]);
            },
            projectPath: '/workspace',
            log: line => {
                logs.push(line);
                if (line.startsWith('[ploinky] image=')) events.push(['banner']);
            },
            warn: line => logs.push(line),
        },
    };
}

test('runCli auto-enables waits identifies final image then attaches', async () => {
    const harness = agentCliHarness();
    await runCliWithDependencies(
        'explorer',
        ['--help'],
        harness.dependencies,
    );
    assert.deepEqual(
        harness.events.map(event => event[0]),
        ['enable', 'ensure', 'ready', 'banner', 'attach'],
    );
    assert.deepEqual(harness.logs.slice(-3), [
        "[ploinky] Attaching to agent 'explorer'",
        '[ploinky] container=nested-explorer',
        '[ploinky] image=docker.io/assistos/ploinky-node:24-bookworm-tools',
    ]);
});

test('runCli no-tty suppresses banners but preserves attachment', async () => {
    const harness = agentCliHarness({ noTTY: true });
    await runCliWithDependencies('explorer', [], harness.dependencies);
    assert.equal(harness.logs.some(line => line.startsWith('[ploinky]')), false);
    assert.ok(harness.events.some(event => event[0] === 'attach'));
});
~~~

In helpLayers.test.mjs, capture console.log around showHelp:

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { showHelp } from '../../cli/services/help.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');

function captureHelp(args, options) {
    const lines = [];
    const original = console.log;
    console.log = value => lines.push(String(value));
    try {
        showHelp(args, options);
    } finally {
        console.log = original;
    }
    return lines.join('\n');
}

test('cli help documents outer and agent forms', () => {
    const text = captureHelp(['cli'], { surface: 'core' });
    assert.match(text, /^cli$/m);
    assert.match(text, /^cli <agentName> \[args\.\.\.\]$/m);
    assert.match(text, /outer runtime/);
    assert.match(text, /manifest/);
});

test('host and core lifecycle help have different scopes', () => {
    const host = captureHelp([], { surface: 'host' });
    const core = captureHelp([], { surface: 'core' });
    assert.match(host, /combined, read-only outer runtime and workspace status/i);
    assert.match(host, /stop core services, then stop the outer runtime/i);
    assert.match(host, /remove the outer runtime and its three volumes/i);
    assert.match(core, /leave the outer runtime running/i);
    assert.match(core, /exit the REPL before running host ploinky stop or ploinky destroy/i);
});
~~~

Add this process test:

~~~js
test('all help aliases bypass dependencies and workspace initialization', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-help-root-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-help-cwd-'));
    try {
        for (const args of [['help'], ['--help'], ['-h']]) {
            const result = spawnSync(process.execPath, [cliEntry, ...args], {
                cwd,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            });
            const output = (result.stdout || '') + (result.stderr || '');
            assert.equal(result.status, 0, args.join(' '));
            assert.match(output, /PLOINKY/);
            assert.doesNotMatch(output, /Ploinky dependencies missing/);
            assert.equal(fs.existsSync(path.join(cwd, '.ploinky')), false);
        }
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
~~~

- [ ] **Step 2: Run focused banner/help tests and verify the red state**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
node --test \
  tests/unit/layerIdentification.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/agentReadiness.test.mjs
~~~

Expected: FAIL because the agent formatter/resolver do not exist, current help has one lifecycle scope and one cli syntax, and no attachment banner is emitted.

- [ ] **Step 3: Implement the agent identity and emit it after readiness**

Append to layerIdentification.js:

~~~js
export function resolveAgentAttachmentIdentity(agentName, containerName, registry = {}) {
    const record = registry[containerName] || {};
    const runtime = record.runtime || 'container';
    const image = record.containerImage
        || (runtime === 'bwrap' || runtime === 'seatbelt'
            ? 'host (' + runtime + ')'
            : '<unknown>');
    return { agentName, containerName, image };
}

export function formatAgentAttachmentBanner({ agentName, containerName, image }) {
    return [
        "[ploinky] Attaching to agent '" + agentName + "'",
        '[ploinky] container=' + containerName,
        '[ploinky] image=' + image,
    ];
}
~~~

Extract the existing runCli body into `runCliWithDependencies(agentName, args, dependencies)`. The dependency object supplies the agents service calls, findAgent, manifest read, ensureAgentService, readiness functions, loadAgentsMap, attach functions, project path, environment, log, and warn; `runCli(agentName, args)` calls it with the current production implementations. This is dependency injection only: do not change lookup, enable mode, manifest command construction, readiness selection, SSO parsing, or bwrap/seatbelt/container branching.

After readiness and after the injected loadAgentsMap(), but before the bwrap/seatbelt/container branch, add:

~~~js
if (!suppressLauncherLogs) {
    const identity = resolveAgentAttachmentIdentity(
        shortAgentName,
        containerName,
        agents,
    );
    for (const line of formatAgentAttachmentBanner(identity)) {
        log(line);
    }
}
~~~

Do not move or rewrite enabled-agent lookup, auto-enable, readiness, raw command construction, runtime selection, or attach calls.

- [ ] **Step 4: Implement host/core help copy and dependency-free help aliases**

Change the public signature to:

~~~js
export function showHelp(args = [], { surface = 'core' } = {}) {
    const topic = args[0];
    const subtopic = args[1];
    const subsubtopic = args[2];
    if (topic) return showDetailedHelp(topic, subtopic, subsubtopic, { surface });
    console.log(mainHelpText(surface));
}
~~~

Add this exact lifecycle-copy helper and interpolate its returned lines into the existing main help:

~~~js
function lifecycleHelpLines(surface) {
    if (surface === 'host') {
        return [
            '  status                         Show combined, read-only outer runtime and workspace status',
            '  stop                           Stop core services, then stop the outer runtime',
            '  destroy                        Confirm and remove the outer runtime and its three volumes',
        ];
    }
    return [
        '  status                         Show workspace/router/agent state',
        '  stop | shutdown | clean         Stop workspace services and leave the outer runtime running',
        '  destroy                        Remove workspace containers and leave the outer runtime running',
        '  Exit the REPL before running host ploinky stop or ploinky destroy.',
    ];
}
~~~

Move the existing main-help template into mainHelpText(surface), replace its current lifecycle lines with lifecycleHelpLines(surface).join('\n'), and return the completed string. Keep every unrelated command line unchanged. Pass {surface} into showDetailedHelp and give status, stop, and destroy the same host/core scope distinction as the main help.

Make detailed cli help contain both exact syntax lines:

~~~text
cli
cli <agentName> [args...]
~~~

The first description is “Open /bin/bash in the managed outer runtime; exit returns to the previous prompt.” The second remains the manifest CLI form. In cli/index.js keep the Task 4 lightweight, pre-import help fast path for help, --help, and -h. Change the REPL welcome sentence in cli/main.js so core destroy no longer claims to remove the outer runtime.

- [ ] **Step 5: Run banner/help and agent regressions**

Run:

~~~bash
node --test \
  tests/unit/layerIdentification.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/cliExitCodes.test.mjs \
  tests/unit/agentReadiness.test.mjs \
  tests/unit/containerRuntime.test.mjs
~~~

Expected: all selected tests pass. PLOINKY_NO_TTY=1 paths produce no layer banner and preserve non-TTY agent attachment.

- [ ] **Step 6: Commit layer identification and help**

~~~bash
git add cli/services/layerIdentification.js cli/services/workspaceUtil.js \
  cli/services/help.js cli/main.js tests/unit/layerIdentification.test.mjs \
  tests/unit/helpLayers.test.mjs tests/unit/agentReadiness.test.mjs
git commit -m "feat: identify cli execution layers"
~~~

### Task 6: Refocus the wrapper into a public-only runtime supervisor

**Files:**

- Rename: ploinky/container/ploinky-box.mjs to ploinky/container/runtime-supervisor.mjs
- Rename: ploinky/container/wrapper-tests.mjs to ploinky/container/runtime-supervisor-tests.mjs
- Rename: ploinky/tests/unit/ploinkyBoxWrapper.test.mjs to ploinky/tests/unit/runtimeSupervisor.test.mjs
- Modify: ploinky/bin/ploinky
- Delete: ploinky/container/ploinky-box
- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs

**Interfaces:**

- Consumes: current instance/volume naming, source/dependency preparation, graph publish planner, branch forwarding, router readiness, and core command forwarding.
- Produces: publicUsageText(), parseHostInvocation(argv, env), routeHostInvocation(invocation), createRuntimeSupervisor(dependencies).run(argv), and runSupervisorWithBoundary(supervisor, argv, stderr), with no public/private mode switch.

parseHostInvocation returns:

~~~js
{
    engine,
    name,
    nameSource,
    port,
    image,
    mountDir,
    mountDirResolved,
    sourceDirResolved,
    listenLan,
    dryRun,
    publish,
    explicit,
    help,
    command,
    args,
}
~~~

explicit is a Set containing the original spelling of every supplied global flag. --expose remains an input alias and records --expose so state-command rejection and publish replacement can distinguish omitted from explicit input.

- [ ] **Step 1: Rename the test files and write failing public-only routing tests**

After the test-file rename, update imports to runtime-supervisor.mjs and add:

~~~js
test('host routing has no box lifecycle namespace', () => {
    assert.deepEqual(routeHostInvocation(parseHostInvocation([])), { kind: 'repl' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['cli'])), {
        kind: 'ordinary',
        forwardedArgs: ['cli'],
        interactive: true,
    });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['status'])), { kind: 'status' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['stop'])), { kind: 'stop' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['destroy'])), { kind: 'destroy' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['start', 'explorer'])), {
        kind: 'start',
        forwardedArgs: ['start', 'explorer'],
    });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['box', 'status'])), {
        kind: 'ordinary',
        forwardedArgs: ['box', 'status'],
        interactive: false,
    });
});

test('public help contains no compatibility surface', () => {
    const help = publicUsageText();
    assert.doesNotMatch(help, /ploinky box/);
    assert.doesNotMatch(help, /ploinky-box\s/);
    assert.doesNotMatch(help, /\bup\b|\bupdate\b|\bcp\b/);
});

for (const argv of [['help'], ['--help'], ['-h']]) {
    test('host help alias ' + argv[0] + ' returns before engine detection', async () => {
        let detections = 0;
        const stderr = captureWritable();
        const raw = createRuntimeSupervisor({
            ...minimalSupervisorDependencies(),
            detectEngine: () => {
                detections += 1;
                throw new Error('must not be called');
            },
        });
        assert.equal(
            await runSupervisorWithBoundary(raw, argv, stderr.stream),
            0,
        );
        assert.equal(detections, 0);
    });
}

test('ordinary command reports missing host engine before mutation', async () => {
    const calls = [];
    const stderr = captureWritable();
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        detectEngine: () => null,
        spawnSyncImpl: (...args) => calls.push(args),
    });
    assert.equal(
        await runSupervisorWithBoundary(raw, ['list', 'agents'], stderr.stream),
        1,
    );
    assert.match(stderr.text(), /requires Podman or Docker on the host/);
    assert.deepEqual(calls, []);
});
~~~

minimalSupervisorDependencies supplies in-memory stdout, stdin, cwd, env, and no-op timing/prompt functions; captureWritable returns `{stream: {write(chunk)}, text()}`. Define both once at the top of runtime-supervisor-tests.mjs and reuse them in later process-independent cases.

Add this launcher assertion:

~~~js
test('host launcher delegates directly to the public-only supervisor', () => {
    const launcher = fs.readFileSync(path.join(ROOT, 'bin', 'ploinky'), 'utf8');
    assert.match(
        launcher,
        /exec node "\$ROOT_DIR\/container\/runtime-supervisor\.mjs" "\$@"/,
    );
    assert.doesNotMatch(launcher, /PLOINKY_PUBLIC_ENTRYPOINT/);
    assert.doesNotMatch(launcher, /container\/ploinky-box\.mjs/);
});
~~~

Retain all graph-driven start, profile, branch, publish-conflict, dependency, and router-readiness tests. Delete only tests whose subject is the standalone launcher, nested box parsing, up, update, run, cp, box logs, or box-specific help.

- [ ] **Step 2: Run the renamed focused test and verify missing exports/old help**

Run:

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/runtimeSupervisor.test.mjs tests/unit/boxPublishPlanner.test.mjs
~~~

Expected: FAIL because runtime-supervisor.mjs and the public-only exports do not exist and the current help advertises box commands.

- [ ] **Step 3: Rename the implementation and remove compatibility code**

Use git mv for both implementation and tests. In runtime-supervisor.mjs:

- Remove PUBLIC_ENTRYPOINT_ENV, BOX_PROGRAM, BOX_COMMANDS, BOX_COMMANDS_REJECT_REMOVED_FLAGS, REMOVED_BOX_FLAGS, activeProgramName, isPublicEntrypoint(), mapCpPath(), mergeBoxCfg(), boxHelpTarget(), assertBoxCommand(), rejectRemovedBoxFlags(), runBoxCommand(), cmdCli(), cmdRun(), cmdCp(), cmdLogs(), cmdUpdate(), and the private usage text.
- Keep and rename capability helpers for engine detection, query/run, instance/volume identity, source/mount/dependency preparation, run arguments, health wait, graph-derived start, router probe, graceful core shutdown, and volume deletion.
- Keep the main-module guard and make main always call createRuntimeSupervisor().run(process.argv.slice(2)).
- Do not add a box token branch. If a user runs ploinky box, the supervisor treats `box` like any other ordinary core token and makes no compatibility promise about core unknown-command handling.

Replace die() and helper-level process.exit calls with thrown SupervisorError instances. Use one exported boundary for both the executable and injected tests:

~~~js
export class SupervisorError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'SupervisorError';
        this.exitCode = exitCode;
    }
}

export async function runSupervisorWithBoundary(
    supervisor,
    argv,
    stderr = process.stderr,
) {
    try {
        return await supervisor.run(argv);
    } catch (error) {
        stderr.write('ploinky: ' + (error.message || error) + '\n');
        return Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
}

async function main() {
    const supervisor = createRuntimeSupervisor(defaultDependencies());
    process.exitCode = await runSupervisorWithBoundary(
        supervisor,
        process.argv.slice(2),
    );
}
~~~

This composable error boundary is required before stop fallback and replacement rollback are added.

Use this routing function:

~~~js
export function routeHostInvocation(invocation) {
    if (invocation.help || invocation.command === 'help') {
        return { kind: 'help', topic: invocation.args };
    }
    if (!invocation.command) return { kind: 'repl' };
    if (invocation.command === 'status') return { kind: 'status' };
    if (invocation.command === 'stop') return { kind: 'stop' };
    if (invocation.command === 'destroy') return { kind: 'destroy' };
    if (invocation.command === 'start') {
        return {
            kind: 'start',
            forwardedArgs: ['start', ...invocation.args],
        };
    }
    return {
        kind: 'ordinary',
        forwardedArgs: [invocation.command, ...invocation.args],
        interactive: ['cli', 'shell', 'sh', '--shell', '-shell']
            .includes(invocation.command),
    };
}
~~~

publicUsageText() returns this authoritative host synopsis followed by the existing global flag descriptions:

~~~text
ploinky - run Ploinky through its managed outer runtime

Usage: ploinky [flags] [command] [args]

Commands:
  ploinky                         Start/reconcile the runtime and open the Ploinky REPL
  p-cli                          Alias for ploinky
  ploinky cli                    Open Bash as podman in /workspace
  ploinky cli <agent> [args...]  Attach to an agent manifest CLI
  ploinky start ...              Start the graph and report router readiness
  ploinky status                 Combined read-only runtime and core status
  ploinky stop                   Stop core services, then the outer runtime
  ploinky destroy                Confirm and delete the runtime and its three volumes
  ploinky help [command]         Show help without starting the runtime
~~~

The flag section lists --name, --port, --publish/--expose, --image, --mount, --listen-lan, --engine, --dry-run, and -h/--help. It says omitted creation flags preserve existing inspected settings and creation flags are invalid for status, stop, and destroy. It contains no removed command.

The supervisor help route must remain host-local:

~~~js
if (route.kind === 'help') {
    if (route.topic.length > 0) {
        showHelp(route.topic, { surface: 'host' });
    } else {
        stdout.write(publicUsageText());
    }
    return 0;
}
~~~

This branch executes before detectEngine(), resolveInstanceIdentity(), source preparation, image inspection, or reconciliation.

- [ ] **Step 4: Point the host launcher directly at the supervisor and delete the shim**

Keep the in-runtime branch of bin/ploinky unchanged. Replace its final two lines with:

~~~bash
exec node "$ROOT_DIR/container/runtime-supervisor.mjs" "$@"
~~~

Delete container/ploinky-box. Update tests/unit/runtimeSupervisor.test.mjs to import ../../container/runtime-supervisor-tests.mjs.

- [ ] **Step 5: Run routing, graph, and absence checks**

Run:

~~~bash
bash -n bin/ploinky bin/p-cli
node --check container/runtime-supervisor.mjs
node --test tests/unit/runtimeSupervisor.test.mjs tests/unit/boxPublishPlanner.test.mjs
test ! -e container/ploinky-box
test ! -e container/ploinky-box.mjs
~~~

Expected: syntax checks and tests pass; both removed paths are absent.

- [ ] **Step 6: Commit the public-only supervisor surface**

~~~bash
git add bin/ploinky container/runtime-supervisor.mjs \
  container/runtime-supervisor-tests.mjs tests/unit/runtimeSupervisor.test.mjs
git add -u container/ploinky-box container/ploinky-box.mjs \
  container/wrapper-tests.mjs tests/unit/ploinkyBoxWrapper.test.mjs
git commit -m "refactor: make runtime supervisor public only"
~~~

### Task 7: Add the engine seam, inspect model, and desired-config planner

**Files:**

- Create: ploinky/container/runtime-engine.mjs
- Create: ploinky/container/runtime-contract.mjs
- Create: ploinky/tests/helpers/runtimeSupervisorHarness.mjs
- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs

**Interfaces:**

- Consumes: full JSON from engine container inspect and image inspect, parsed invocation explicitness, existing graph-derived publish specs, and existing source/volume naming.
- Produces: createEngineClient(options), normalizeContainerInspect(engine, raw), normalizeImageInspect(raw), validateImageContract(image), mergeDesiredRuntimeConfig(invocation, existing, generatedPublishes), diffRuntimeConfig(actual, desired), planReconciliation(state), and buildRuntimeRunArgs(config, engineOptions).

The normalized RuntimeConfig shape is:

~~~js
{
    instance,
    image,
    imageId,
    contract,
    state,
    running,
    user,
    privileged,
    sourceDir,
    mountDir,
    binds,
    volumes: { workspace, containers, deps },
    routerPublish: { hostIp, hostPort, containerPort: '8080', protocol: 'tcp' },
    extraPublishes,
    devices,
    securityOpts,
    env,
}
~~~

- [ ] **Step 1: Add failing inspect, merge, plan, and engine-parity tests**

Use these complete inspect fixtures and assert both engines normalize to the same creation fields:

~~~js
const dockerInspect = [{
    Id: 'container-id',
    Name: '/ploinky-box-demo',
    Image: 'sha256:runtime-v1',
    Config: {
        Image: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        User: 'podman',
        Env: [
            'PLOINKY_WORKSPACE_ROOT=/workspace',
            'PLOINKY_RUNTIME_NAME=ploinky-box-demo',
        ],
    },
    State: { Status: 'running' },
    HostConfig: {
        Privileged: true,
        Binds: [
            '/src/ploinky:/opt/ploinky:ro',
            '/host/data:/workspace/mounted',
        ],
        PortBindings: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
            '7880/udp': [{ HostIp: '127.0.0.1', HostPort: '17880' }],
        },
        Devices: [
            { PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' },
            { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        ],
        SecurityOpt: ['seccomp=unconfined'],
    },
    Mounts: [
        { Type: 'volume', Name: 'ploinky-box-demo-workspace', Destination: '/workspace' },
        { Type: 'volume', Name: 'ploinky-box-demo-containers', Destination: '/home/podman/.local/share/containers' },
        { Type: 'volume', Name: 'ploinky-box-demo-ploinky-deps', Destination: '/opt/ploinky/node_modules' },
        { Type: 'bind', Source: '/src/ploinky', Destination: '/opt/ploinky', Mode: 'ro', RW: false },
        { Type: 'bind', Source: '/host/data', Destination: '/workspace/mounted', Mode: 'rw', RW: true },
    ],
}];

const podmanInspect = [{
    Id: 'container-id',
    Name: 'ploinky-box-demo',
    Image: 'sha256:runtime-v1',
    ImageName: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
    Config: {
        Image: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        User: 'podman',
        Env: [
            'PLOINKY_WORKSPACE_ROOT=/workspace',
            'PLOINKY_RUNTIME_NAME=ploinky-box-demo',
        ],
    },
    State: { Status: 'running', Running: true },
    HostConfig: {
        Privileged: true,
        Binds: [
            '/src/ploinky:/opt/ploinky:ro',
            '/host/data:/workspace/mounted:rw,rprivate,rbind',
        ],
        PortBindings: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
            '7880/udp': [{ HostIp: '127.0.0.1', HostPort: '17880' }],
        },
        Devices: [
            { PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' },
            { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        ],
        SecurityOpt: ['seccomp=unconfined'],
    },
    Mounts: [
        { Type: 'volume', Name: 'ploinky-box-demo-workspace', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-workspace/_data', Destination: '/workspace', Driver: 'local', Mode: '', RW: true, Propagation: '' },
        { Type: 'volume', Name: 'ploinky-box-demo-containers', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-containers/_data', Destination: '/home/podman/.local/share/containers', Driver: 'local', Mode: '', RW: true, Propagation: '' },
        { Type: 'volume', Name: 'ploinky-box-demo-ploinky-deps', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-ploinky-deps/_data', Destination: '/opt/ploinky/node_modules', Driver: 'local', Mode: 'U', RW: true, Propagation: '' },
        { Type: 'bind', Source: '/src/ploinky', Destination: '/opt/ploinky', Driver: '', Mode: 'ro', RW: false, Propagation: 'rprivate' },
        { Type: 'bind', Source: '/host/data', Destination: '/workspace/mounted', Driver: '', Mode: 'rw,rprivate,rbind', RW: true, Propagation: 'rprivate' },
    ],
}];

const dockerConfig = normalizeContainerInspect('docker', dockerInspect);
const podmanConfig = normalizeContainerInspect('podman', podmanInspect);
assert.deepEqual(
    { ...podmanConfig, binds: dockerConfig.binds },
    dockerConfig,
);
assert.ok(podmanConfig.binds.includes(
    '/host/data:/workspace/mounted:rw,rprivate,rbind',
));
assert.deepEqual(dockerConfig.routerPublish, {
    hostIp: '127.0.0.1',
    hostPort: '18080',
    containerPort: '8080',
    protocol: 'tcp',
});
assert.deepEqual(dockerConfig.extraPublishes, [{
    hostIp: '127.0.0.1',
    hostPort: '17880',
    containerPort: '7880',
    protocol: 'udp',
}]);
assert.equal(dockerConfig.sourceDir, '/src/ploinky');
assert.equal(dockerConfig.mountDir, '/host/data');
~~~

The Podman fixture is intentionally written independently from dockerInspect and includes Podman-style ImageName, non-slash Name, State.Running, volume Sources/Modes, and bind propagation. normalizeContainerInspect must canonicalize the bind strings so Podman's inspected `:rw,rprivate,rbind` option remains preserved rather than forcing the Docker fixture's shorter bind.

Add these exact planning assertions:

~~~js
const desired = { ...dockerConfig, contract: '1' };
assert.deepEqual(
    planReconciliation({ existing: null, desired, contractMatches: true }),
    { action: 'create', reasons: ['missing'] },
);
assert.deepEqual(
    planReconciliation({
        existing: { ...desired, state: 'exited', running: false },
        desired,
        contractMatches: true,
    }),
    { action: 'start', reasons: [] },
);
assert.deepEqual(
    planReconciliation({
        existing: { ...desired, state: 'running', running: true },
        desired,
        contractMatches: true,
    }),
    { action: 'reuse', reasons: [] },
);
assert.equal(
    planReconciliation({
        existing: { ...desired, image: 'legacy' },
        desired,
        contractMatches: false,
    }).action,
    'replace',
);
~~~

Add this merge test:

~~~js
test('desired config preserves omissions and replaces explicit publishes', () => {
    const existing = {
        ...desired,
        image: 'registry.example/custom-runtime:v1',
        contract: '1',
        mountDir: '/kept/mount',
        routerPublish: {
            hostIp: '0.0.0.0',
            hostPort: '19000',
            containerPort: '8080',
            protocol: 'tcp',
        },
        extraPublishes: [{
            hostIp: '127.0.0.1',
            hostPort: '7000',
            containerPort: '7000',
            protocol: 'tcp',
        }],
    };
    const omitted = mergeDesiredRuntimeConfig(
        { explicit: new Set(), publish: [] },
        existing,
        [],
    );
    assert.equal(omitted.image, 'registry.example/custom-runtime:v1');
    assert.equal(omitted.mountDir, '/kept/mount');
    assert.equal(omitted.routerPublish.hostPort, '19000');
    assert.deepEqual(omitted.extraPublishes, existing.extraPublishes);

    const changed = mergeDesiredRuntimeConfig(
        {
            explicit: new Set(['--publish']),
            publish: ['127.0.0.1:9000:9000/tcp'],
        },
        existing,
        ['127.0.0.1:7880:7880/udp', '127.0.0.1:7880:7880/udp'],
    );
    assert.deepEqual(changed.extraPublishes, [
        {
            hostIp: '127.0.0.1',
            hostPort: '9000',
            containerPort: '9000',
            protocol: 'tcp',
        },
        {
            hostIp: '127.0.0.1',
            hostPort: '7880',
            containerPort: '7880',
            protocol: 'udp',
        },
    ]);
});

test('desired config changes only explicitly selected creation fields', () => {
    const existing = {
        ...normalizeContainerInspect('docker', dockerInspect),
        contract: '1',
    };
    const assertOnly = (changed, fields) => {
        const actualRest = structuredClone(changed);
        const expectedRest = structuredClone(existing);
        for (const field of fields) {
            delete actualRest[field];
            delete expectedRest[field];
        }
        assert.deepEqual(actualRest, expectedRest);
    };

    const port = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--port', '19191', 'list', 'agents']),
        existing,
    );
    assert.equal(port.routerPublish.hostPort, '19191');
    assertOnly(port, ['routerPublish']);

    const image = mergeDesiredRuntimeConfig(
        parseHostInvocation([
            '--image', 'registry.example/runtime:v1', 'list', 'agents',
        ]),
        existing,
    );
    assert.equal(image.image, 'registry.example/runtime:v1');
    assertOnly(image, ['image']);

    const mount = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--mount', '/new/mount', 'list', 'agents']),
        existing,
    );
    assert.equal(mount.mountDir, '/new/mount');
    assert.ok(mount.binds.includes('/new/mount:/workspace/mounted'));
    assertOnly(mount, ['mountDir', 'binds']);

    const lan = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--listen-lan', 'list', 'agents']),
        existing,
    );
    assert.equal(lan.routerPublish.hostIp, '0.0.0.0');
    assertOnly(lan, ['routerPublish']);

    for (const flag of ['--publish', '--expose']) {
        const publish = mergeDesiredRuntimeConfig(
            parseHostInvocation([
                flag, '127.0.0.1:9000:9000/tcp', 'list', 'agents',
            ]),
            existing,
        );
        assert.deepEqual(publish.extraPublishes, [{
            hostIp: '127.0.0.1',
            hostPort: '9000',
            containerPort: '9000',
            protocol: 'tcp',
        }]);
        assertOnly(publish, ['extraPublishes']);
    }
});

test('omitted image migrates only the known legacy official reference', () => {
    const custom = {
        ...normalizeContainerInspect('docker', dockerInspect),
        image: 'registry.example/custom-runtime:current',
        contract: '',
    };
    assert.equal(
        mergeDesiredRuntimeConfig(
            { explicit: new Set(), publish: [] },
            custom,
        ).image,
        'registry.example/custom-runtime:current',
    );
    const legacy = {
        ...custom,
        image: 'docker.io/assistos/ploinky-box:podman-node24',
    };
    assert.equal(
        mergeDesiredRuntimeConfig(
            { explicit: new Set(), publish: [] },
            legacy,
        ).image,
        REQUIRED_RUNTIME_IMAGE,
    );
});

test('podman and docker build equivalent creation commands', () => {
    const dockerConfig = normalizeContainerInspect('docker', dockerInspect);
    const podmanConfig = normalizeContainerInspect('podman', podmanInspect);
    const dockerArgs = buildRuntimeRunArgs(dockerConfig, {
        engine: 'docker',
        selinux: false,
    });
    const podmanArgs = buildRuntimeRunArgs(podmanConfig, {
        engine: 'podman',
        selinux: false,
    });
    const canonical = args => args.map(value =>
        value.replace(':/opt/ploinky/node_modules:U', ':/opt/ploinky/node_modules')
            .replace(':/workspace/mounted:rw,rprivate,rbind', ':/workspace/mounted')
    );
    assert.deepEqual(canonical(podmanArgs), canonical(dockerArgs));
    assert.ok(podmanArgs.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules:U',
    ));
    assert.ok(dockerArgs.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules',
    ));
    for (const args of [podmanArgs, dockerArgs]) {
        assert.ok(args.includes('--privileged'));
        assert.ok(args.includes('/dev/fuse:/dev/fuse:rwm'));
        assert.ok(args.includes('/dev/net/tun:/dev/net/tun:rwm'));
        assert.ok(args.includes('seccomp=unconfined'));
        assert.equal(args.at(-1), REQUIRED_IMAGE);
    }
});
~~~

- [ ] **Step 2: Run the focused model tests and verify missing-module failures**

Run:

~~~bash
node --test --test-name-pattern="inspect|desired config|reconciliation plan|engine parity" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: FAIL with missing runtime-engine/runtime-contract exports.

- [ ] **Step 3: Implement the injectable engine client**

runtime-engine.mjs must export:

~~~js
import { spawn, spawnSync } from 'node:child_process';

export function createEngineClient({
    name,
    dryRun = false,
    spawnSyncImpl = spawnSync,
    spawnImpl = spawn,
    stdout = process.stdout,
    stderr = process.stderr,
}) {
    return {
        name,
        query(args) {
            const result = spawnSyncImpl(name, args, { encoding: 'utf8' });
            return {
                ok: result.status === 0 && !result.error,
                status: Number.isInteger(result.status) ? result.status : 1,
                stdout: result.stdout || '',
                stderr: result.stderr || '',
            };
        },
        run(args, { silence = 'none', allowFail = false } = {}) {
            if (dryRun) {
                if (silence === 'none') stdout.write('DRY-RUN: ' + name + ' ' + args.join(' ') + '\n');
                return 0;
            }
            const result = spawnSyncImpl(name, args, {
                stdio: [
                    'inherit',
                    silence === 'none' ? 'inherit' : 'ignore',
                    silence === 'all' ? 'ignore' : 'inherit',
                ],
            });
            const code = Number.isInteger(result.status) ? result.status : 1;
            if (code !== 0 && !allowFail) {
                throw new Error(name + ' ' + args.join(' ') + ' exited ' + code);
            }
            return code;
        },
        streamContains(args, needle) {
            return streamContainsWith(spawnImpl, name, args, needle);
        },
        streamToStderr(args) {
            return streamToStderrWith(spawnImpl, stderr, name, args);
        },
    };
}
~~~

streamContainsWith and streamToStderrWith retain the current child-stream behavior but return Promises and never call process.exit.

- [ ] **Step 4: Implement pure contract/config functions**

runtime-contract.mjs must start with:

~~~js
export const REQUIRED_RUNTIME_IMAGE =
    'docker.io/assistos/ploinky-box:podman-node24-runtime-v1';
export const RUNTIME_CONTRACT_LABEL =
    'io.assistos.ploinky.runtime-contract';
export const REQUIRED_RUNTIME_CONTRACT = '1';
export const LEGACY_RUNTIME_IMAGES = new Set([
    'docker.io/assistos/ploinky-box:podman-node24',
    'assistos/ploinky-box:podman-node24',
]);

export function normalizeImageInspect(raw) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const labels = value?.Config?.Labels || value?.Labels || {};
    return {
        id: value?.Id || value?.ID || '',
        labels,
        contract: String(labels[RUNTIME_CONTRACT_LABEL] || ''),
    };
}

export function validateImageContract(image, imageRef) {
    if (image.contract === REQUIRED_RUNTIME_CONTRACT) return;
    const observed = image.contract || '<missing>';
    throw new Error(
        "Runtime image '" + imageRef + "' requires "
        + RUNTIME_CONTRACT_LABEL + '=' + REQUIRED_RUNTIME_CONTRACT
        + '; observed ' + observed,
    );
}
~~~

When an existing container is present, the supervisor performs a local image inspect by imageId or image reference and sets existing.contract from normalizeImageInspect() before calling mergeDesiredRuntimeConfig(). This is a local inspection only; it never pulls.

Implement inspect normalization with this shape-preserving core:

~~~js
function inspectRecord(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed[0] : parsed;
}

function envMap(entries = []) {
    return Object.fromEntries(entries.map(entry => {
        const index = entry.indexOf('=');
        return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
    }));
}

function normalizedPublishes(bindings = {}) {
    const result = [];
    for (const [target, values] of Object.entries(bindings)) {
        const [containerPort, protocol = 'tcp'] = target.split('/');
        for (const value of values || []) {
            result.push({
                hostIp: value.HostIp || '0.0.0.0',
                hostPort: String(value.HostPort),
                containerPort,
                protocol,
            });
        }
    }
    return result.sort((a, b) =>
        (a.containerPort + '/' + a.protocol + '/' + a.hostPort)
            .localeCompare(b.containerPort + '/' + b.protocol + '/' + b.hostPort)
    );
}

export function normalizeContainerInspect(engine, raw) {
    const value = inspectRecord(raw);
    const mounts = value.Mounts || [];
    const publishes = normalizedPublishes(value.HostConfig?.PortBindings);
    const namedDestinations = new Set([
        '/workspace',
        '/home/podman/.local/share/containers',
        '/opt/ploinky/node_modules',
    ]);
    const byDestination = destination =>
        mounts.find(mount => mount.Destination === destination);
    const routerPublish = publishes.find(item =>
        item.containerPort === '8080' && item.protocol === 'tcp'
    ) || null;
    return {
        instance: String(value.Name || '').replace(/^\//, ''),
        image: value.Config?.Image || value.ImageName || '',
        imageId: value.Image || value.ImageID || '',
        contract: '',
        state: value.State?.Status || '',
        running: value.State?.Status === 'running',
        user: value.Config?.User || '',
        privileged: Boolean(value.HostConfig?.Privileged),
        sourceDir: byDestination('/opt/ploinky')?.Source || '',
        mountDir: byDestination('/workspace/mounted')?.Source || '',
        binds: (value.HostConfig?.Binds || [])
            .filter(bind => !namedDestinations.has(bind.split(':')[1])),
        volumes: {
            workspace: byDestination('/workspace')?.Name || '',
            containers: byDestination('/home/podman/.local/share/containers')?.Name || '',
            deps: byDestination('/opt/ploinky/node_modules')?.Name || '',
        },
        routerPublish,
        extraPublishes: publishes.filter(item => item !== routerPublish),
        devices: (value.HostConfig?.Devices || []).map(device => ({
            hostPath: device.PathOnHost,
            containerPath: device.PathInContainer,
            permissions: device.CgroupPermissions || 'rwm',
        })),
        securityOpts: [...(value.HostConfig?.SecurityOpt || [])],
        env: envMap(value.Config?.Env || []),
    };
}
~~~

mergeDesiredRuntimeConfig uses invocation.explicit, which is a Set of the exact flags supplied by the user:

~~~js
export function mergeDesiredRuntimeConfig(
    invocation,
    existing,
    generatedPublishes = [],
) {
    const desired = structuredClone(existing || createDefaultRuntimeConfig(invocation));
    const explicit = invocation.explicit || new Set();

    desired.image = explicit.has('--image')
        ? invocation.image
        : existing && !LEGACY_RUNTIME_IMAGES.has(existing.image)
            ? existing.image
            : REQUIRED_RUNTIME_IMAGE;

    if (explicit.has('--port')) desired.routerPublish.hostPort = invocation.port;
    if (explicit.has('--listen-lan')) desired.routerPublish.hostIp = '0.0.0.0';
    if (explicit.has('--mount')) {
        desired.mountDir = invocation.mountDirResolved;
        desired.binds = replaceDestinationBind(
            desired.binds,
            '/workspace/mounted',
            invocation.mountDirResolved + ':/workspace/mounted',
        );
    }
    if (explicit.has('--publish') || explicit.has('--expose')) {
        desired.extraPublishes = invocation.publish.map(normalizePublishSpec);
    }
    desired.extraPublishes = mergeAndValidatePublishes(
        desired.extraPublishes,
        generatedPublishes.map(normalizePublishSpec),
    );
    desired.env.PLOINKY_WORKSPACE_ROOT = '/workspace';
    desired.env.PLOINKY_RUNTIME_NAME = desired.instance;
    return desired;
}

export function diffRuntimeConfig(actual, desired) {
    const fields = [
        'instance', 'image', 'user', 'privileged', 'sourceDir', 'mountDir',
        'binds', 'volumes', 'routerPublish', 'extraPublishes', 'devices',
        'securityOpts', 'env',
    ];
    return fields.filter(field =>
        JSON.stringify(actual[field]) !== JSON.stringify(desired[field])
    );
}

export function planReconciliation({ existing, desired, contractMatches }) {
    if (!existing) return { action: 'create', reasons: ['missing'] };
    const reasons = diffRuntimeConfig(existing, desired);
    if (!contractMatches) reasons.unshift('runtime-contract');
    if (reasons.length > 0) return { action: 'replace', reasons };
    if (!existing.running) return { action: 'start', reasons: [] };
    return { action: 'reuse', reasons: [] };
}
~~~

Use this adapter at the parser boundary so RuntimeConfig always stores the normalized publish shape:

~~~js
function normalizePublishSpec(spec) {
    const parsed = parseExplicitPublishSpec(spec);
    return {
        hostIp: parsed.hostIp,
        hostPort: parsed.hostPortSpec || parsed.containerPortSpec,
        containerPort: parsed.containerPortSpec,
        protocol: parsed.protocol,
    };
}

function replaceDestinationBind(binds, destination, replacement) {
    return [
        ...binds.filter(bind => bind.split(':')[1] !== destination),
        replacement,
    ];
}
~~~

Create new runtimes with this complete default:

~~~js
export function createDefaultRuntimeConfig(invocation) {
    const instance = instanceName(invocation);
    const volumes = volumeNames(invocation);
    const sourceDir = invocation.sourceDirResolved;
    const mountDir = invocation.mountDirResolved || '';
    return {
        instance,
        image: invocation.image || REQUIRED_RUNTIME_IMAGE,
        imageId: '',
        contract: REQUIRED_RUNTIME_CONTRACT,
        state: '',
        running: false,
        user: 'podman',
        privileged: true,
        sourceDir,
        mountDir,
        binds: [
            sourceDir + ':/opt/ploinky:ro',
            ...(mountDir ? [mountDir + ':/workspace/mounted'] : []),
        ],
        volumes,
        routerPublish: {
            hostIp: invocation.listenLan ? '0.0.0.0' : '127.0.0.1',
            hostPort: String(invocation.port || '8080'),
            containerPort: '8080',
            protocol: 'tcp',
        },
        extraPublishes: (invocation.publish || []).map(normalizePublishSpec),
        devices: [
            { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
            { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
        ],
        securityOpts: ['seccomp=unconfined'],
        env: {
            PLOINKY_WORKSPACE_ROOT: '/workspace',
            PLOINKY_RUNTIME_NAME: instance,
        },
    };
}
~~~

parseHostInvocation defaults `image` to REQUIRED_RUNTIME_IMAGE, `port` to `8080`, `publish` to `[]`, and `listenLan` to false while leaving those flags absent from explicit. mergeAndValidatePublishes converts normalized records back through parseExplicitPublishSpec, removes exact duplicates, and applies the existing intervalsOverlap and wildcard-bind conflict rules from appendGraphDrivenStartPublishes; move that current conflict loop without changing its error text, and keep its graph/publish tests mandatory.

Start buildRuntimeRunArgs from the normalized privilege/device/security fields:

~~~js
const args = ['run', '-d', '--init', '--name', config.instance];
if (config.privileged) args.push('--privileged');
if (config.user) args.push('--user', config.user);
for (const device of config.devices) {
    args.push(
        '--device',
        device.hostPath + ':' + device.containerPath + ':' + device.permissions,
    );
}
for (const option of config.securityOpts) {
    args.push('--security-opt', option);
}
if (engineOptions.selinux && !config.securityOpts.includes('label=disable')) {
    args.push('--security-opt', 'label=disable');
}
~~~

Complete buildRuntimeRunArgs by appending publishes, volumes, binds, environment, and image in this order:

~~~js
for (const publish of [config.routerPublish, ...config.extraPublishes]) {
    const protocol = publish.protocol === 'tcp' ? '' : '/' + publish.protocol;
    const host = publish.hostIp ? publish.hostIp + ':' : '';
    args.push(
        '-p',
        host + publish.hostPort + ':'
            + publish.containerPort + protocol,
    );
}
args.push(
    '-v', config.volumes.workspace + ':/workspace',
    '-v', config.volumes.containers + ':/home/podman/.local/share/containers',
    '-v', config.volumes.deps + ':/opt/ploinky/node_modules'
        + (engineOptions.engine === 'podman' ? ':U' : ''),
);
const binds = config.binds.length > 0
    ? config.binds
    : [
        config.sourceDir + ':/opt/ploinky:ro',
        ...(config.mountDir ? [config.mountDir + ':/workspace/mounted'] : []),
    ];
for (const bind of binds) {
    args.push('-v', bind);
}
for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', key + '=' + value);
}
args.push(config.image);
return args;
~~~

Use normalized devices and securityOpts when building the earlier part of args, including label=disable only when engine SELinux detection requires it. Do not mount container/ploinky-box-marker; contract v1 owns /etc/ploinky-box.

- [ ] **Step 5: Implement the stateful fake engine**

createFakeEngine() in tests/helpers/runtimeSupervisorHarness.mjs returns:

~~~js
{
    engineClient,
    calls,
    state: {
        container,
        images,
        volumes,
    },
}
~~~

query() and run() record {kind, args, options}; run() mutates container state for pull, run, start, stop, rm, and volume rm. A successful pull of REQUIRED_IMAGE inserts `contractV1Image()` under both the requested reference and its ID; custom pull results come from an optional `pullImages[reference]` fixture and otherwise remain unavailable. failures uses exact phase signatures: `pull`, `start`, `exec ploinky stop`, `run create`, `run replacement`, `health reuse`, `health start`, `health create`, `health replacement`, `run rollback`, `health rollback`, `rm container`, and `volume rm`. The harness classifies a run after removal of an inspected old container as replacement, and the next run after a replacement failure as rollback; waitHealthy records the supplied reuse/start/create/replacement/rollback phase. createSupervisorHarness(options) injects this client, deterministic stdout/stderr buffers, askLine replies, fetch responses, and zero-delay sleep into createRuntimeSupervisor(). It retains that raw throwing supervisor internally and exposes `supervisor.run(argv)` as `runSupervisorWithBoundary(rawSupervisor, argv, capturedStderr)`, so every later test observes the same numeric exit/error formatting as the executable. Its options include engine, container, images, pullImages, volumes, failures, answer, stdin, and stdoutIsTTY. Its return value exposes stdout, stderr, and prompt as strings in addition to supervisor, rawSupervisor, calls, and state.

Define the shared scenario builders in runtime-supervisor-tests.mjs so every later task uses the same shapes:

~~~js
const REQUIRED_IMAGE =
    'docker.io/assistos/ploinky-box:podman-node24-runtime-v1';

function contractV1Image(id = 'sha256:runtime-v1') {
    return {
        Id: id,
        Config: {
            Labels: { 'io.assistos.ploinky.runtime-contract': '1' },
        },
    };
}

function legacyImage(id = 'sha256:legacy') {
    return { Id: id, Config: { Labels: {} } };
}

function contractV1Images() {
    const image = contractV1Image();
    return {
        [REQUIRED_IMAGE]: image,
        [image.Id]: image,
    };
}

function compatibleRunningContainer(overrides = {}) {
    return {
        inspect: structuredClone(dockerInspect[0]),
        logs: '[ploinky-box] self-check OK\n',
        coreStatus: 0,
        coreStdout: 'core: running\n',
        ...overrides,
    };
}

function compatibleStoppedContainer(overrides = {}) {
    const value = compatibleRunningContainer(overrides);
    value.inspect.State.Status = 'exited';
    return value;
}

function legacyRunningContainerWithCustomConfig() {
    const value = compatibleRunningContainer();
    value.inspect.Image = 'sha256:legacy';
    value.inspect.Config.Image = 'docker.io/assistos/ploinky-box:podman-node24';
    value.inspect.Config.Env.push('CUSTOM_RUNTIME_SETTING=kept');
    value.inspect.HostConfig.PortBindings['8080/tcp'][0] = {
        HostIp: '0.0.0.0',
        HostPort: '18080',
    };
    return value;
}

function statusScenarios() {
    return [
        { name: 'missing', input: { container: null }, code: 1, core: false },
        { name: 'stopped', input: { container: compatibleStoppedContainer(), images: contractV1Images() }, code: 1, core: false },
        { name: 'compatible', input: { container: compatibleRunningContainer(), images: contractV1Images() }, code: 0, core: true },
        {
            name: 'outdated',
            input: {
                container: legacyRunningContainerWithCustomConfig(),
                images: { 'sha256:legacy': legacyImage() },
            },
            code: 1,
            core: false,
        },
        {
            name: 'image metadata missing',
            input: {
                container: compatibleRunningContainer(),
                images: {},
            },
            code: 1,
            core: false,
        },
        {
            name: 'unhealthy',
            input: {
                container: compatibleRunningContainer({ logs: 'self-check failed\n' }),
                images: contractV1Images(),
            },
            code: 1,
            core: false,
        },
        {
            name: 'core failure',
            input: {
                container: compatibleRunningContainer({ coreStatus: 6 }),
                images: contractV1Images(),
            },
            code: 6,
            core: true,
        },
    ];
}
~~~

After createSupervisorHarness exists, add an end-to-end fake-engine parity case that reaches the actual create command through the supervisor:

~~~js
test('fake podman and docker construct equivalent runtime creates', async () => {
    const runArgs = {};
    for (const engine of ['podman', 'docker']) {
        const harness = createSupervisorHarness({
            engine,
            container: null,
            images: contractV1Images(),
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
        runArgs[engine] = harness.calls.find(call => call.args[0] === 'run').args;
    }
    const canonical = args => args.map(value =>
        value.replace(':/opt/ploinky/node_modules:U', ':/opt/ploinky/node_modules')
    );
    assert.deepEqual(canonical(runArgs.podman), canonical(runArgs.docker));
    assert.ok(runArgs.podman.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules:U',
    ));
    assert.ok(runArgs.docker.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules',
    ));
});
~~~

- [ ] **Step 6: Run model, parity, and existing graph tests**

Run:

~~~bash
node --test --test-name-pattern="inspect|desired config|reconciliation plan|engine parity" \
  tests/unit/runtimeSupervisor.test.mjs
node --test tests/unit/boxPublishPlanner.test.mjs
~~~

Expected: all selected tests pass for engine equal to podman and docker.

- [ ] **Step 7: Commit the runtime state model**

~~~bash
git add container/runtime-engine.mjs container/runtime-contract.mjs \
  container/runtime-supervisor.mjs container/runtime-supervisor-tests.mjs \
  tests/helpers/runtimeSupervisorHarness.mjs
git commit -m "feat: model managed runtime state"
~~~

### Task 8: Make combined status strictly read-only

**Files:**

- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs

**Interfaces:**

- Consumes: normalized container/image inspection from Task 7, engine query/run, the self-check log marker, router publish data, and core ploinky status.
- Produces: reportCombinedStatus(context) returning 0 only for a running, contract-compatible, self-check-healthy runtime whose core status invocation succeeds.

- [ ] **Step 1: Add failing status matrix and mutation-ban tests**

Cover missing, stopped, compatible running, wrong contract, missing self-check, and core-status failure. Use one table for both engine names:

~~~js
for (const engine of ['podman', 'docker']) {
    test(engine + ' status is read-only in every state', async () => {
        for (const scenario of statusScenarios()) {
            const harness = createSupervisorHarness({ engine, ...scenario.input });
            const code = await harness.supervisor.run(['status']);
            assert.equal(code, scenario.code, scenario.name);
            const forbidden = new Set(['pull', 'run', 'start', 'stop', 'rm', 'volume']);
            assert.equal(
                harness.calls.some(call => forbidden.has(call.args[0])),
                false,
                scenario.name,
            );
            const coreExecs = harness.calls.filter(call =>
                call.args[0] === 'exec'
                && call.args.slice(-2).join(' ') === 'ploinky status'
            );
            assert.equal(coreExecs.length, scenario.core ? 1 : 0, scenario.name);
        }
    });
}
~~~

Add the exact compatible-output assertion:

~~~js
test('compatible status prints runtime contract publishes health and core output', async () => {
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['status']), 0);
    for (const line of [
        'runtime: ploinky-box-demo (running)',
        'image: docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        'publish: 127.0.0.1:18080 -> 8080/tcp',
        'publish: 127.0.0.1:17880 -> 7880/udp',
        'contract: compatible (expected 1, observed 1)',
        'health: healthy',
        'core: running',
    ]) {
        assert.match(harness.stdout, new RegExp(escapeRegExp(line)));
    }
});

test('stopped status still reports image contract without invoking core', async () => {
    const harness = createSupervisorHarness({
        container: compatibleStoppedContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['status']), 1);
    assert.match(harness.stdout, /runtime: ploinky-box-demo \(exited\)/);
    assert.match(
        harness.stdout,
        /contract: compatible \(expected 1, observed 1\)/,
    );
    assert.equal(harness.calls.some(call => call.args[0] === 'exec'), false);
});
~~~

Define escapeRegExp in the test file as `value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. The fake engine writes container.coreStdout to the injected supervisor stdout for `exec ... ploinky status`. Missing, stopped, outdated, and unhealthy fixtures therefore prove both the nonzero result and the absence of a core exec.

- [ ] **Step 2: Run the status tests and verify current mutation/coverage failures**

Run:

~~~bash
node --test --test-name-pattern="status" tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: FAIL because the current path lacks normalized contract reporting and the old public status semantics do not enforce the complete read-only matrix.

- [ ] **Step 3: Implement reportCombinedStatus**

Use this control flow:

~~~js
export async function reportCombinedStatus(context) {
    const { engine, invocation, stdout } = context;
    const instance = instanceName(invocation);
    const inspected = inspectRuntimeIfPresent(engine, instance);
    if (!inspected) {
        stdout.write("runtime: " + instance + " (missing)\n");
        return 1;
    }

    printRuntimeSummary(stdout, inspected);
    const image = inspectLocalImage(engine, inspected.imageId || inspected.image);
    const observed = image?.contract || '<missing>';
    const compatible = observed === REQUIRED_RUNTIME_CONTRACT;
    stdout.write(
        'contract: ' + (compatible ? 'compatible' : 'outdated')
        + ' (expected ' + REQUIRED_RUNTIME_CONTRACT
        + ', observed ' + observed + ')\n',
    );
    if (!compatible) return 1;
    if (!inspected.running) return 1;

    const logs = engine.query(['logs', instance]);
    if (!logs.ok || !logs.stdout.includes('[ploinky-box] self-check OK')) {
        stdout.write('health: unhealthy\n');
        return 1;
    }
    stdout.write('health: healthy\n');

    return engine.run([
        'exec', '-e', 'PLOINKY_RUNTIME_NAME=' + instance,
        '-w', '/workspace', instance, 'ploinky', 'status',
    ], { allowFail: true });
}
~~~

inspectRuntimeIfPresent and inspectLocalImage parse full JSON through Task 7. printRuntimeSummary prints every normalized publish and does no mutation. Do not call ensureImage(), reconcileRuntime(), waitHealthy(), or dependency installation.

Use these read-only helpers:

~~~js
function inspectRuntimeIfPresent(engine, instance) {
    const result = engine.query(['container', 'inspect', instance]);
    if (!result.ok) return null;
    return normalizeContainerInspect(engine.name, result.stdout);
}

function inspectLocalImage(engine, imageRef) {
    const result = engine.query(['image', 'inspect', imageRef]);
    if (!result.ok) return null;
    return normalizeImageInspect(JSON.parse(result.stdout));
}

function printRuntimeSummary(stdout, runtime) {
    stdout.write('runtime: ' + runtime.instance + ' (' + runtime.state + ')\n');
    stdout.write('image: ' + runtime.image + '\n');
    const publishes = [runtime.routerPublish, ...runtime.extraPublishes].filter(Boolean);
    for (const publish of publishes) {
        stdout.write(
            'publish: ' + (publish.hostIp || '*') + ':' + publish.hostPort
            + ' -> ' + publish.containerPort + '/' + publish.protocol + '\n',
        );
    }
}
~~~

- [ ] **Step 4: Run status and routing regressions**

Run:

~~~bash
node --test --test-name-pattern="status|routing" tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: all selected cases pass and the fake engine records no forbidden status mutation.

- [ ] **Step 5: Commit read-only combined status**

~~~bash
git add container/runtime-supervisor.mjs container/runtime-supervisor-tests.mjs
git commit -m "feat: add read-only combined runtime status"
~~~

### Task 9: Adopt contract v1 and automatically create, start, or reuse runtimes

**Files:**

- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-contract.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs
- Delete: ploinky/container/ploinky-box-marker

**Interfaces:**

- Consumes: Manual Gate A, Task 7 reconciliation plans, image contract validation, health/dependency helpers, and Task 6 routing.
- Produces: reconcileRuntime(context) returning a normalized running runtime for every action, an initial safe replaceRuntimeTransaction(context), and forwardCoreCommand(context, args, interactive) returning the core exit code.

- [ ] **Step 1: Add failing create/start/reuse and forwarding tests**

For Podman and Docker, assert:

~~~js
test('matching running runtime is reused without pull or recreation', async () => {
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    const code = await harness.supervisor.run(['list', 'agents']);
    assert.equal(code, 0);
    assert.equal(harness.calls.some(call => call.args[0] === 'pull'), false);
    assert.equal(harness.calls.some(call => call.args[0] === 'run'), false);
    assert.equal(harness.calls.some(call => call.args[0] === 'start'), false);
    assert.ok(harness.calls.some(call =>
        call.args[0] === 'exec'
        && call.args.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo')
        && call.args.slice(-2).join(' ') === 'list agents'
    ));
});

test('stopped compatible runtime starts without pulling', async () => {
    const harness = createSupervisorHarness({
        container: compatibleStoppedContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.ok(harness.calls.some(call => call.args[0] === 'start'));
    assert.equal(harness.calls.some(call => call.args[0] === 'pull'), false);
});

test('missing runtime obtains and validates v1 before create', async () => {
    const harness = createSupervisorHarness({ container: null, images: {} });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.deepEqual(
        harness.calls.filter(call => ['pull', 'image', 'run'].includes(call.args[0]))
            .map(call => call.args[0]),
        ['image', 'pull', 'image', 'run'],
    );
    const run = harness.calls.find(call => call.args[0] === 'run').args;
    assert.ok(run.includes('docker.io/assistos/ploinky-box:podman-node24-runtime-v1'));
    assert.ok(run.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo'));
});

test('legacy runtime is replaced through the ordinary command path', async () => {
    const harness = createSupervisorHarness({
        container: legacyRunningContainerWithCustomConfig(),
        images: {
            'sha256:legacy': legacyImage(),
            [REQUIRED_IMAGE]: contractV1Image(),
        },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.deepEqual(
        harness.calls
            .filter(call => ['pull', 'image', 'exec', 'stop', 'rm', 'run'].includes(call.args[0]))
            .map(call => call.args[0])
            .slice(0, 7),
        ['image', 'pull', 'image', 'exec', 'stop', 'rm', 'run'],
    );
});

test('host bare cli rejects non-tty before runtime mutation', async () => {
    const harness = createSupervisorHarness({
        stdin: { isTTY: false },
        stdoutIsTTY: false,
        container: null,
    });
    assert.equal(await harness.supervisor.run(['cli']), 1);
    assert.match(harness.stderr, /requires an interactive terminal/);
    assert.equal(
        harness.calls.some(call => ['pull', 'run', 'start'].includes(call.args[0])),
        false,
    );
});

test('host agent cli preserves non-tty mode', async () => {
    const harness = createSupervisorHarness({
        stdin: { isTTY: false },
        stdoutIsTTY: false,
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['cli', 'explorer']), 0);
    const exec = harness.calls.find(call => call.args[0] === 'exec').args;
    assert.equal(exec.includes('-it'), false);
    assert.ok(exec.includes('-i'));
    assert.ok(exec.includes('PLOINKY_NO_TTY=1'));
});

test('unobtainable replacement image leaves the legacy runtime untouched', async () => {
    const harness = createSupervisorHarness({
        container: legacyRunningContainerWithCustomConfig(),
        images: { 'sha256:legacy': legacyImage() },
        failures: { pull: 23 },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    assert.equal(
        harness.calls.some(call =>
            ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
        ),
        false,
    );
    assert.equal(harness.state.container.inspect.State.Status, 'running');
    assert.match(harness.stderr, /pull.*exited 23/);
});

test('failed create self-check removes only the failed container', async () => {
    const harness = createSupervisorHarness({
        container: null,
        images: {},
        failures: { 'health create': 7 },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    assert.ok(harness.calls.some(call => call.args[0] === 'rm'));
    assert.equal(harness.calls.some(call => call.args[0] === 'volume'), false);
    assert.equal(harness.calls.some(call =>
        call.args[0] === 'exec'
        && call.args.slice(-2).join(' ') === 'list agents'
    ), false);
    assert.equal(harness.state.container, null);
});
~~~

Add the explicit-image contract cases:

~~~js
test('explicit compatible custom image is accepted', async () => {
    const custom = 'registry.example/runtime:custom';
    const harness = createSupervisorHarness({
        container: null,
        images: { [custom]: contractV1Image('sha256:custom') },
    });
    assert.equal(
        await harness.supervisor.run(['--image', custom, 'list', 'agents']),
        0,
    );
    const run = harness.calls.find(call => call.args[0] === 'run').args;
    assert.equal(run.at(-1), custom);
});

for (const [name, image, observed] of [
    ['missing label', legacyImage('sha256:no-label'), '<missing>'],
    [
        'wrong label',
        {
            Id: 'sha256:wrong-label',
            Config: {
                Labels: { 'io.assistos.ploinky.runtime-contract': '2' },
            },
        },
        '2',
    ],
]) {
    test('explicit custom image rejects ' + name + ' before runtime mutation', async () => {
        const custom = 'registry.example/runtime:' + name.replace(' ', '-');
        const harness = createSupervisorHarness({
            container: null,
            images: { [custom]: image },
        });
        assert.equal(
            await harness.supervisor.run(['--image', custom, 'list', 'agents']),
            1,
        );
        assert.match(harness.stderr, new RegExp(escapeRegExp(custom)));
        assert.match(
            harness.stderr,
            /io\.assistos\.ploinky\.runtime-contract=1/,
        );
        assert.match(
            harness.stderr,
            new RegExp('observed ' + escapeRegExp(observed)),
        );
        assert.equal(
            harness.calls.some(call =>
                ['run', 'start', 'stop', 'rm'].includes(call.args[0])
            ),
            false,
        );
    });
}

test('invalid explicit custom image leaves an existing v1 runtime untouched', async () => {
    const custom = 'registry.example/runtime:invalid';
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        pullImages: { [custom]: legacyImage('sha256:invalid-custom') },
    });
    assert.equal(
        await harness.supervisor.run(['--image', custom, 'list', 'agents']),
        1,
    );
    assert.match(harness.stderr, /observed <missing>/);
    assert.equal(
        harness.calls.some(call =>
            ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
        ),
        false,
    );
    assert.equal(harness.state.container.inspect.State.Status, 'running');
});

test('omitted incompatible custom reference is validated, not silently replaced', async () => {
    const custom = 'registry.example/runtime:current';
    const container = compatibleRunningContainer();
    container.inspect.Config.Image = custom;
    container.inspect.Image = 'sha256:custom-old';
    const harness = createSupervisorHarness({
        container,
        images: { 'sha256:custom-old': legacyImage('sha256:custom-old') },
        pullImages: { [custom]: legacyImage('sha256:custom-new') },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    const pull = harness.calls.find(call => call.args[0] === 'pull').args;
    assert.equal(pull[1], custom);
    assert.equal(pull.includes(REQUIRED_IMAGE), false);
    assert.equal(
        harness.calls.some(call =>
            ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
        ),
        false,
    );
});
~~~

- [ ] **Step 2: Run reconciliation tests and verify current failures**

Run:

~~~bash
node --test --test-name-pattern="reused|stopped compatible|missing runtime|custom image|contract|unobtainable|self-check" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: FAIL because ordinary routing still uses the old ensure/up behavior and does not validate image labels or inject the resolved runtime name.

- [ ] **Step 3: Implement image acquisition and create/start/reuse**

Use this image helper:

~~~js
function obtainAndValidateImage(engine, imageRef, { forcePull = false } = {}) {
    let inspected = forcePull ? null : inspectLocalImage(engine, imageRef);
    if (!inspected) {
        engine.run(['pull', imageRef]);
        inspected = inspectLocalImage(engine, imageRef);
    }
    if (!inspected) {
        throw new Error("Runtime image '" + imageRef + "' was unavailable after pull");
    }
    validateImageContract(inspected, imageRef);
    return inspected;
}
~~~

Implement these three actions in reconcileRuntime:

~~~js
switch (plan.action) {
    case 'reuse':
        await waitHealthy({ ...runtimeContext, phase: 'reuse' });
        await ensureDependencies(runtimeContext);
        return existing;
    case 'start':
        engine.run(['start', desired.instance]);
        await waitHealthy({ ...runtimeContext, phase: 'start' });
        fixDepsOwnership(runtimeContext);
        await ensureDependencies(runtimeContext);
        return { ...desired, state: 'running', running: true };
    case 'create': {
        obtainAndValidateImage(engine, desired.image);
        ensureNamedVolumes(runtimeContext);
        engine.run(buildRuntimeRunArgs(desired, engineOptions));
        try {
            await waitHealthy({ ...runtimeContext, phase: 'create' });
            fixDepsOwnership(runtimeContext);
            await ensureDependencies(runtimeContext);
            return { ...desired, state: 'running', running: true };
        } catch (error) {
            engine.run(['rm', '-f', desired.instance], {
                allowFail: true,
                silence: 'all',
            });
            throw error;
        }
    }
    case 'replace':
        return replaceRuntimeTransaction(runtimeContext);
}
~~~

Implement the initial safe transaction in the same task:

~~~js
export async function replaceRuntimeTransaction(context) {
    const { engine, existing, desired } = context;
    const previous = structuredClone(existing);
    const previousImage = existing.imageId || existing.image;
    obtainAndValidateImage(engine, desired.image, { forcePull: true });
    if (existing.running) {
        const coreCode = engine.run([
            'exec', '-e', 'PLOINKY_RUNTIME_NAME=' + existing.instance,
            '-w', '/workspace', existing.instance, 'timeout', '30',
            'ploinky', 'stop',
        ], { allowFail: true, silence: 'all' });
        if (coreCode !== 0) {
            throw new Error('runtime replacement aborted: graceful core shutdown exited ' + coreCode);
        }
        engine.run(['stop', existing.instance], { silence: 'all' });
    }
    engine.run(['rm', existing.instance], { silence: 'all' });
    try {
        engine.run(buildRuntimeRunArgs(desired, context.engineOptions));
        await waitHealthy({ ...context, phase: 'replacement' });
        fixDepsOwnership(context);
        await ensureDependencies(context);
        return { ...desired, state: 'running', running: true };
    } catch (error) {
        engine.run(['rm', '-f', desired.instance], {
            allowFail: true,
            silence: 'all',
        });
        const rollback = { ...previous, image: previousImage };
        engine.run(buildRuntimeRunArgs(rollback, context.engineOptions));
        await waitHealthy({
            ...context,
            desired: rollback,
            phase: 'rollback',
        });
        throw new Error(
            'runtime replacement failed; previous runtime restored: '
            + (error.message || error),
        );
    }
}
~~~

Task 10 adds adversarial rollback-failure aggregation, phase reporting, and complete configuration round-trip coverage to this already non-destructive transaction.

forwardCoreCommand must use:

~~~js
const { engine, stdin, stdout } = context;
const instance = runtime.instance;
const execArgs = ['exec'];
const hasTTY = Boolean(stdin.isTTY && stdout.isTTY);
if (interactive) execArgs.push(hasTTY ? '-it' : '-i');
if (args[0] === 'cli' && args.length > 1 && !hasTTY) {
    execArgs.push('-e', 'PLOINKY_NO_TTY=1');
}
execArgs.push(
    '-e', 'PLOINKY_RUNTIME_NAME=' + instance,
    '-w', '/workspace',
    instance,
);
if (args.length === 0) execArgs.push('p-cli');
else execArgs.push('ploinky', ...args);
return engine.run(execArgs, { allowFail: true });
~~~

Pass interactive=true for repl and for commands marked interactive by routeHostInvocation. Before reconciliation, reject args equal to ['cli'] unless both stdin.isTTY and stdout.isTTY. The error is “cli: parameterless 'cli' requires an interactive terminal.” Agent form cli <agent> remains valid without a TTY and uses -i plus PLOINKY_NO_TTY=1. Ordinary, repl, cli, and graph-aware start routes then call reconcileRuntime before forwarding. Help, status, stop, and destroy never call it.

- [ ] **Step 4: Remove the source-owned marker mount**

Delete container/ploinky-box-marker. Remove BOX_MARKER_RELATIVE_PATH and its bind from buildRuntimeRunArgs. Keep /etc/ploinky-box detection in bin/ploinky and core runtime validation; contract-v1 supplies the file.

- [ ] **Step 5: Run create/start/reuse and launcher tests**

Run:

~~~bash
node --test --test-name-pattern="reused|stopped compatible|missing runtime|legacy runtime|custom image|contract|unobtainable|self-check|launcher|interactive terminal" \
  tests/unit/runtimeSupervisor.test.mjs
test ! -e container/ploinky-box-marker
~~~

Expected: all selected tests pass, invalid images cause no runtime mutation, and every forwarded exec carries PLOINKY_RUNTIME_NAME.

- [ ] **Step 6: Commit contract adoption**

~~~bash
git add container/runtime-supervisor.mjs container/runtime-contract.mjs \
  container/runtime-supervisor-tests.mjs
git add -u container/ploinky-box-marker
git commit -m "feat: adopt ploinky runtime contract v1"
~~~

### Task 10: Harden transactional replacement and rollback failure reporting

**Files:**

- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-contract.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs
- Modify: ploinky/tests/helpers/runtimeSupervisorHarness.mjs

**Interfaces:**

- Consumes: old image ID/reference and normalized creation config, force-pulled desired image, graceful core stop, buildRuntimeRunArgs(), waitHealthy(), and fake failure injection.
- Produces: replaceRuntimeTransaction(context), which either returns the healthy replacement or restores the prior image/config and throws a phase-specific nonzero error.

- [ ] **Step 1: Add failing ordering, preservation, shutdown, and rollback tests**

Use exact call-order assertions:

~~~js
function assertLegacyCreationConfig(args, expectedImage) {
    for (const value of [
        '0.0.0.0:18080:8080',
        '127.0.0.1:17880:7880/udp',
        '/src/ploinky:/opt/ploinky:ro',
        '/host/data:/workspace/mounted',
        'ploinky-box-demo-workspace:/workspace',
        'ploinky-box-demo-containers:/home/podman/.local/share/containers',
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules',
        '/dev/fuse:/dev/fuse:rwm',
        '/dev/net/tun:/dev/net/tun:rwm',
        'seccomp=unconfined',
        'PLOINKY_WORKSPACE_ROOT=/workspace',
        'PLOINKY_RUNTIME_NAME=ploinky-box-demo',
        'CUSTOM_RUNTIME_SETTING=kept',
    ]) {
        assert.ok(args.includes(value), value);
    }
    assert.ok(args.includes('--privileged'));
    assert.equal(args[args.indexOf('--user') + 1], 'podman');
    assert.equal(args.at(-1), expectedImage);
}

test('replacement validates before graceful shutdown and preserves volumes', async () => {
    const harness = createSupervisorHarness({
        container: legacyRunningContainerWithCustomConfig(),
        images: {
            'sha256:legacy': legacyImage(),
            [REQUIRED_IMAGE]: contractV1Image(),
        },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const phases = harness.calls
        .filter(call => ['pull', 'image', 'exec', 'stop', 'rm', 'run'].includes(call.args[0]))
        .map(call => call.args[0]);
    assert.deepEqual(
        phases.slice(0, 7),
        ['image', 'pull', 'image', 'exec', 'stop', 'rm', 'run'],
    );
    assert.equal(harness.calls.some(call => call.args[0] === 'volume'), false);

    const replacementRun = harness.calls.findLast(call => call.args[0] === 'run').args;
    assertLegacyCreationConfig(replacementRun, REQUIRED_IMAGE);
});
~~~

Add these concrete failure and merge cases:

~~~js
test('graceful core shutdown failure leaves the old runtime running', async () => {
    const harness = createSupervisorHarness({
        container: legacyRunningContainerWithCustomConfig(),
        images: {
            'sha256:legacy': legacyImage(),
            [REQUIRED_IMAGE]: contractV1Image(),
        },
        failures: { 'exec ploinky stop': 9 },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    assert.equal(
        harness.calls.some(call =>
            ['stop', 'rm', 'run'].includes(call.args[0])
        ),
        false,
    );
    assert.equal(harness.state.container.inspect.State.Status, 'running');
});

for (const [name, failures] of [
    ['replacement run', { 'run replacement': 7 }],
    ['replacement health', { 'health replacement': 7 }],
]) {
    test(name + ' failure restores the prior image and full config', async () => {
        const harness = createSupervisorHarness({
            container: legacyRunningContainerWithCustomConfig(),
            images: {
                'sha256:legacy': legacyImage(),
                [REQUIRED_IMAGE]: contractV1Image(),
            },
            failures,
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        const runs = harness.calls.filter(call => call.args[0] === 'run');
        const rollback = runs.at(-1).args;
        assertLegacyCreationConfig(rollback, 'sha256:legacy');
        assert.ok(harness.calls.some(call =>
            call.kind === 'health' && call.phase === 'rollback'
        ));
        assert.equal(harness.calls.some(call => call.args[0] === 'volume'), false);
    });
}

for (const [name, rollbackFailure] of [
    ['rollback run', { 'run rollback': 8 }],
    ['rollback health', { 'health rollback': 8 }],
]) {
    test(name + ' failure reports both phases without removing volumes', async () => {
        const harness = createSupervisorHarness({
            container: legacyRunningContainerWithCustomConfig(),
            images: {
                'sha256:legacy': legacyImage(),
                [REQUIRED_IMAGE]: contractV1Image(),
            },
            failures: {
                'run replacement': 7,
                ...rollbackFailure,
            },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        assert.match(harness.stderr, /replacement phase: .*exited 7/);
        assert.match(harness.stderr, /rollback phase: .*exited 8/);
        assert.equal(harness.calls.some(call => call.args[0] === 'volume'), false);
    });
}

test('explicit port and publish replace only their inspected fields', () => {
    const existing = {
        ...normalizeContainerInspect('docker', dockerInspect),
        contract: '1',
    };
    const portChanged = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--port', '19191', 'list', 'agents']),
        existing,
        [],
    );
    assert.equal(portChanged.routerPublish.hostPort, '19191');
    assert.deepEqual(
        { ...portChanged, routerPublish: existing.routerPublish },
        existing,
    );

    const publishChanged = mergeDesiredRuntimeConfig(
        parseHostInvocation([
            '--publish', '127.0.0.1:9000:9000/tcp',
            'list', 'agents',
        ]),
        existing,
        [],
    );
    assert.deepEqual(publishChanged.extraPublishes, [{
        hostIp: '127.0.0.1',
        hostPort: '9000',
        containerPort: '9000',
        protocol: 'tcp',
    }]);
    assert.deepEqual(
        { ...publishChanged, extraPublishes: existing.extraPublishes },
        existing,
    );
});
~~~

- [ ] **Step 2: Run replacement tests and verify rollback aggregation fails red**

Run:

~~~bash
node --test --test-name-pattern="replacement|rollback|graceful shutdown|preserves volumes" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: FAIL because the initial transaction does not yet aggregate a failed rollback with the replacement failure and has not been proven to round-trip every inspected configuration field.

- [ ] **Step 3: Implement the transaction and rollback**

Use this exact phase order:

~~~js
export async function replaceRuntimeTransaction(context) {
    const { engine, existing, desired } = context;
    const previousConfig = structuredClone(existing);
    const previousImage = existing.imageId || existing.image;

    obtainAndValidateImage(engine, desired.image, { forcePull: true });

    if (existing.running) {
        const coreCode = engine.run([
            'exec', '-e', 'PLOINKY_RUNTIME_NAME=' + existing.instance,
            '-w', '/workspace', existing.instance, 'timeout', '30',
            'ploinky', 'stop',
        ], { allowFail: true, silence: 'all' });
        if (coreCode !== 0) {
            throw new Error('runtime replacement aborted: graceful core shutdown exited ' + coreCode);
        }
        engine.run(['stop', existing.instance], { silence: 'all' });
    }

    engine.run(['rm', existing.instance], { silence: 'all' });
    try {
        engine.run(buildRuntimeRunArgs(desired, context.engineOptions));
        await waitHealthy({ ...context, phase: 'replacement' });
        fixDepsOwnership(context);
        await ensureDependencies(context);
        return { ...desired, state: 'running', running: true };
    } catch (replacementError) {
        engine.run(['rm', '-f', desired.instance], {
            allowFail: true,
            silence: 'all',
        });
        try {
            const rollback = { ...previousConfig, image: previousImage };
            engine.run(buildRuntimeRunArgs(rollback, context.engineOptions));
            await waitHealthy({
                ...context,
                desired: rollback,
                phase: 'rollback',
            });
        } catch (rollbackError) {
            throw new AggregateError(
                [replacementError, rollbackError],
                'runtime replacement failed and rollback failed; replacement phase: '
                + (replacementError.message || replacementError)
                + '; rollback phase: '
                + (rollbackError.message || rollbackError),
            );
        }
        throw new Error(
            'runtime replacement failed; previous runtime restored: '
            + (replacementError.message || replacementError),
        );
    }
}
~~~

No catch/finally branch may call volume rm. Preserve old bind options, security options, devices, published host IPs/ports, source mount, optional mount, user, and named volumes from previousConfig.

- [ ] **Step 4: Run replacement, configuration, and engine-parity tests**

Run:

~~~bash
node --test --test-name-pattern="replacement|rollback|graceful shutdown|preserves volumes|desired config|engine parity" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: all selected tests pass for Podman and Docker; pull/image validation precedes exec/stop/rm; no replacement path removes a volume.

- [ ] **Step 5: Commit transactional replacement**

~~~bash
git add container/runtime-supervisor.mjs container/runtime-contract.mjs \
  container/runtime-supervisor-tests.mjs tests/helpers/runtimeSupervisorHarness.mjs
git commit -m "feat: make runtime replacement transactional"
~~~

### Task 11: Make top-level stop and destroy system-wide and state-aware

**Files:**

- Modify: ploinky/container/runtime-supervisor.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs
- Modify: ploinky/cli/services/help.js

**Interfaces:**

- Consumes: direct runtime inspection, engine run/query, exact volumeNames(), invocation.explicit, and injected askLine().
- Produces: stopSystem(context) and destroySystem(context), both returning numeric status and never calling reconciliation.

- [ ] **Step 1: Add failing stop, destroy, and state-flag tests**

Add these assertions:

~~~js
test('stop attempts outer stop after core failure', async () => {
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        failures: { 'exec ploinky stop': 9 },
    });
    assert.equal(await harness.supervisor.run(['stop']), 1);
    const phases = harness.calls
        .filter(call => call.kind === 'run')
        .map(call => call.args[0]);
    assert.deepEqual(phases, ['exec', 'stop']);
    assert.match(harness.stderr, /core shutdown: failed \(exit 9\)/);
    assert.match(harness.stdout, /outer runtime stop: succeeded/);
    assert.equal(harness.calls.some(call => call.args[0] === 'pull'), false);
});

test('destroy requires the exact target confirmation', async () => {
    const harness = createSupervisorHarness({
        container: compatibleStoppedContainer(),
        volumes: [
            'ploinky-box-demo-workspace',
            'ploinky-box-demo-containers',
            'ploinky-box-demo-ploinky-deps',
        ],
        answer: 'y',
    });
    assert.equal(await harness.supervisor.run(['destroy']), 0);
    assert.match(harness.prompt, /ploinky-box-demo/);
    assert.match(harness.prompt, /ploinky-box-demo-workspace/);
    assert.match(harness.prompt, /ploinky-box-demo-containers/);
    assert.match(harness.prompt, /ploinky-box-demo-ploinky-deps/);
    assert.deepEqual(
        harness.calls.find(call => call.args[0] === 'volume').args,
        [
            'volume', 'rm',
            'ploinky-box-demo-workspace',
            'ploinky-box-demo-containers',
            'ploinky-box-demo-ploinky-deps',
        ],
    );
});
~~~

Add the remaining state cases explicitly:

~~~js
for (const [name, container] of [
    ['missing', null],
    ['already stopped', compatibleStoppedContainer()],
]) {
    test('stop is successful when runtime is ' + name, async () => {
        const harness = createSupervisorHarness({
            container,
            images: container ? contractV1Images() : {},
        });
        assert.equal(await harness.supervisor.run(['stop']), 0);
        assert.equal(
            harness.calls.some(call =>
                ['exec', 'stop', 'pull', 'run'].includes(call.args[0])
            ),
            false,
        );
    });
}

test('destroy is idempotent when container and selected volumes are missing', async () => {
    const harness = createSupervisorHarness({
        container: null,
        volumes: [],
    });
    assert.equal(await harness.supervisor.run(['destroy']), 0);
    assert.equal(harness.prompt, '');
    assert.equal(
        harness.calls.some(call => call.kind === 'run'),
        false,
    );
});

for (const answer of ['n', '']) {
    test('destroy refusal ' + JSON.stringify(answer) + ' mutates nothing', async () => {
        const harness = createSupervisorHarness({
            container: compatibleStoppedContainer(),
            volumes: ['ploinky-box-demo-workspace'],
            answer,
        });
        assert.equal(await harness.supervisor.run(['destroy']), 1);
        assert.equal(
            harness.calls.some(call =>
                ['stop', 'rm', 'volume'].includes(call.args[0])
            ),
            false,
        );
    });
}

test('destroy reports removal failure and still attempts selected cleanup', async () => {
    const harness = createSupervisorHarness({
        container: compatibleStoppedContainer(),
        volumes: [
            'ploinky-box-demo-workspace',
            'ploinky-box-demo-containers',
            'ploinky-box-demo-ploinky-deps',
        ],
        answer: 'y',
        failures: { 'rm container': 7 },
    });
    assert.equal(await harness.supervisor.run(['destroy']), 1);
    assert.ok(harness.calls.some(call => call.args[0] === 'volume'));
});

const creationFlagCases = [
    ['--port', '19090'],
    ['--publish', '127.0.0.1:9000:9000/tcp'],
    ['--expose', '127.0.0.1:9000:9000/tcp'],
    ['--image', 'registry.example/runtime:test'],
    ['--mount', '/tmp/mounted'],
    ['--listen-lan'],
];
for (const command of ['status', 'stop', 'destroy']) {
    for (const flagArgs of creationFlagCases) {
        test(command + ' rejects creation flag ' + flagArgs[0], async () => {
            const harness = createSupervisorHarness({ container: null, volumes: [] });
            assert.equal(
                await harness.supervisor.run([...flagArgs, command]),
                1,
            );
            assert.match(harness.stderr, /only valid for runtime creation/);
            assert.equal(
                harness.calls.some(call => call.kind === 'run'),
                false,
            );
        });
    }
}

test('state commands accept engine and instance selectors', async () => {
    const harness = createSupervisorHarness({ container: null });
    assert.equal(
        await harness.supervisor.run([
            '--engine', 'docker', '--name', 'alternate', 'stop',
        ]),
        0,
    );
    assert.doesNotMatch(harness.stderr, /only valid for runtime creation/);
});
~~~

- [ ] **Step 2: Run state-command tests and verify current failures**

Run:

~~~bash
node --test --test-name-pattern="stop|destroy|state-command flags" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: FAIL because current top-level stop is ordinary forwarding, missing destroy is an error, graceful-stop status is discarded, and state-command creation flags are not rejected uniformly.

- [ ] **Step 3: Implement creation-flag rejection and stop**

After parsing, retain an explicit Set containing each supplied global option. Before routing state commands:

~~~js
const CREATION_FLAGS = new Set([
    '--port', '--publish', '--expose', '--image', '--mount', '--listen-lan',
]);

export function assertStateCommandFlags(invocation) {
    if (!['status', 'stop', 'destroy'].includes(invocation.command)) return;
    const rejected = [...invocation.explicit].find(flag => CREATION_FLAGS.has(flag));
    if (rejected) {
        throw new Error(invocation.command + ': ' + rejected + ' is only valid for runtime creation');
    }
}
~~~

Implement stop:

~~~js
export function stopSystem({ engine, invocation, stdout, stderr }) {
    const instance = instanceName(invocation);
    const existing = inspectRuntimeIfPresent(engine, instance);
    if (!existing || !existing.running) {
        stdout.write("runtime: '" + instance + "' already stopped\n");
        return 0;
    }
    const coreCode = engine.run([
        'exec', '-e', 'PLOINKY_RUNTIME_NAME=' + instance,
        '-w', '/workspace', instance, 'timeout', '30', 'ploinky', 'stop',
    ], { allowFail: true, silence: 'all' });
    const outerCode = engine.run(['stop', instance], {
        allowFail: true,
        silence: 'all',
    });
    if (coreCode === 0) stdout.write('core shutdown: succeeded\n');
    else stderr.write('core shutdown: failed (exit ' + coreCode + ')\n');
    if (outerCode === 0) stdout.write('outer runtime stop: succeeded\n');
    else stderr.write('outer runtime stop: failed (exit ' + outerCode + ')\n');
    return coreCode === 0 && outerCode === 0 ? 0 : 1;
}
~~~

- [ ] **Step 4: Implement idempotent confirmed destroy**

Use this mutation order after confirmation: optional core stop when running, outer stop with allowFail, container rm with allowFail, then one volume rm command naming exactly the three selected volumes. If no container and none of those volumes exists, print nothing to remove and return 0 without prompting.

~~~js
const prompt =
    "Remove container '" + instance + "' and volumes '"
    + workspace + "' + '" + containers + "' + '" + deps + "'? [y/N] ";
const reply = await askLine(prompt);
if (!/^[yY]$/.test(reply || '')) {
    stderr.write('destroy: aborted\n');
    return 1;
}
~~~

Accumulate command failures and return 1 if any selected resource removal fails. Do not inspect or pull an image.

- [ ] **Step 5: Run state commands and no-reconcile assertions**

Run:

~~~bash
node --test --test-name-pattern="status|stop|destroy|state-command flags" \
  tests/unit/runtimeSupervisor.test.mjs
~~~

Expected: all state-command tests pass; no status/stop/destroy scenario records pull, replacement run, or dependency installation.

- [ ] **Step 6: Commit state-aware lifecycle commands**

~~~bash
git add container/runtime-supervisor.mjs container/runtime-supervisor-tests.mjs \
  cli/services/help.js
git commit -m "feat: make stop and destroy system wide"
~~~

### Task 12: Preserve graph-aware start and replace compatibility smoke/docs

**Files:**

- Rename: ploinky/container/smoke-box.mjs to ploinky/container/smoke-runtime.mjs
- Modify: ploinky/container/runtime-supervisor-tests.mjs
- Modify: ploinky/README.md
- Modify: ploinky/container/README.md
- Modify: ploinky/docs/code-derived-agent-lifecycle.md
- Modify: ploinky/docs/specs/DS004-agent-manifest-and-registry.md
- Modify: ploinky/docs/specs/DS005-runtime-execution-and-isolation.md
- Modify: ploinky/docs/specs/DS008-dependency-caches-and-startup-readiness.md

**Interfaces:**

- Consumes: current planBoxPublishesForStart(), parseExplicitPublishSpec(), branch inference, profile selection, dependency mount/install, router probe, and final host/core behavior.
- Produces: one public-entrypoint smoke flow and authoritative documentation with no live compatibility references.

- [ ] **Step 1: Add failing graph/start preservation and absence assertions**

Transfer the named graph/start regressions listed below into the renamed test file, then add:

~~~js
test('authoritative runtime files have no removed public surface', () => {
    for (const file of [
        'README.md',
        'container/README.md',
        'bin/ploinky',
        'container/runtime-supervisor.mjs',
        'container/smoke-runtime.mjs',
    ]) {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(text, /ploinky box/);
        assert.doesNotMatch(text, /container\/ploinky-box(?:\s|$)/);
        assert.doesNotMatch(text, /ploinky-box\.mjs/);
    }
});
~~~

Keep these exact renamed regression cases from runtime-supervisor-tests.mjs; preserve their assertion bodies while changing only the helper/supervisor names introduced by Tasks 6-9:

~~~text
managed start preserves branch flags while forcing the core router to 8080
managed start forwards an inferred source branch exactly once
managed start publishes only active-profile graph openPorts
managed start preserves explicit publishes and skips conflicting generated publishes
managed start does not duplicate an exact explicit generated publish
managed start maps the selected host router port to container port 8080
managed start probes the selected host router port after core start succeeds
~~~

The readiness case uses the injected fetch recorder and asserts this ordering exactly: the fake engine records `exec ... ploinky start ... 8080`, then fetch records `http://127.0.0.1:<selected-port>/status`; a failed core start records no fetch. The publish cases continue to assert the concrete TCP and UDP examples `8081:8081`, `3478:3478`, `3478:3478/udp`, `7882-7892:7882-7892/udp`, and `20000-20010:20000-20010/udp`, plus deterministic suppression of an explicit `0.0.0.0:3478:3478/udp` conflict.

- [ ] **Step 2: Run graph/start/docs tests and verify stale references**

Run:

~~~bash
node --test --test-name-pattern="start|publish|branch|authoritative runtime files" \
  tests/unit/runtimeSupervisor.test.mjs
node --test tests/unit/boxPublishPlanner.test.mjs
~~~

Expected: graph tests retain their baseline result; the new absence test fails on README/container README and the old smoke filename/content.

- [ ] **Step 3: Rewrite the smoke test around bin/ploinky only**

Rename the file and replace it with this public-entrypoint skeleton. The selected engine is used only for assertions and emergency cleanup, never to create, start, stop, or normally destroy the runtime:

~~~js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(ROOT, 'bin', 'ploinky');
const NAME = 'runtime-smoke-' + process.pid;
const INSTANCE = 'ploinky-box-' + NAME;
const IMAGE = process.env.SMOKE_IMAGE
    || 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1';
const PORT = process.env.SMOKE_PORT || '18080';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-smoke-'));
const ENV = { ...process.env, PLOINKY_BOX_INSTALL_DEPS: '1' };

function selectEngine() {
    const candidates = process.env.SMOKE_ENGINE
        ? [process.env.SMOKE_ENGINE]
        : ['podman', 'docker'];
    const selected = candidates.find(name =>
        spawnSync(name, ['version'], { stdio: 'ignore' }).status === 0
    );
    if (!selected) throw new Error('smoke requires podman or docker');
    return selected;
}

const ENGINE = selectEngine();
const VOLUMES = [
    INSTANCE + '-workspace',
    INSTANCE + '-containers',
    INSTANCE + '-ploinky-deps',
];

function invoke(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: TMP,
        env: ENV,
        encoding: 'utf8',
        stdio: options.input === undefined
            ? ['ignore', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe'],
        input: options.input,
    });
}

function requireOk(label, result) {
    if (result.status === 0 && !result.error) return;
    throw new Error(
        label + ' failed (' + result.status + '): '
        + (result.stderr || result.stdout || result.error || ''),
    );
}

function ploinky(args, options) {
    return invoke(PLOINKY, ['--engine', ENGINE, '--name', NAME, ...args], options);
}

function containerExists() {
    return invoke(ENGINE, ['container', 'inspect', INSTANCE]).status === 0;
}

function volumeExists(name) {
    return invoke(ENGINE, ['volume', 'inspect', name]).status === 0;
}

try {
    requireOk('host-local help', ploinky(['help']));
    if (containerExists()) throw new Error('help created the runtime');

    requireOk(
        'automatic runtime startup',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    requireOk(
        'nested podman version',
        invoke(ENGINE, ['exec', INSTANCE, 'podman', 'version']),
    );
    requireOk(
        'nested podman info',
        invoke(ENGINE, ['exec', INSTANCE, 'podman', 'info']),
    );
    requireOk('combined status', ploinky(['status']));
    requireOk('first stop', ploinky(['stop']));
    requireOk('idempotent stop', ploinky(['stop']));
    requireOk('confirmed destroy', ploinky(['destroy'], { input: 'y\n' }));

    if (containerExists()) throw new Error('destroy left ' + INSTANCE);
    for (const volume of VOLUMES) {
        if (volumeExists(volume)) throw new Error('destroy left ' + volume);
    }
    process.stdout.write('runtime smoke passed\n');
} finally {
    if (containerExists()) {
        invoke(ENGINE, ['rm', '-f', INSTANCE]);
    }
    for (const volume of VOLUMES) {
        if (volumeExists(volume)) invoke(ENGINE, ['volume', 'rm', volume]);
    }
    fs.rmSync(TMP, { recursive: true, force: true });
}
~~~

The script exits nonzero on the first thrown assertion. Keep only `SMOKE_IMAGE`, `SMOKE_ENGINE`, and `SMOKE_PORT` overrides; remove `SMOKE_AGENT`, `SMOKE_PUBLIC_PLOINKY`, and direct compatibility-launcher code.

- [ ] **Step 4: Update authoritative docs and DS contracts**

Invoke the review_specs skill before editing DS004, DS005, and DS008. Preserve their numbered decision format and update only affected Core Content and Decisions & Questions.

All authoritative docs must encode this exact table:

| Invocation | Documented effect |
| --- | --- |
| ploinky or p-cli | Reconcile/start outer runtime; open Ploinky REPL |
| ploinky cli | Reconcile/start outer runtime; open /bin/bash as podman in /workspace |
| ploinky cli <agent> | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| ploinky start ... | Reconcile/start outer runtime; preserve graph publishes and router readiness |
| ploinky status | Inspect outer contract/publishes/health and running core status without mutation |
| ploinky stop | Stop core services, then stop outer runtime; keep volumes |
| ploinky destroy | Confirm exact instance and remove its container plus three volumes |
| REPL status/stop/destroy | Core workspace/router/agent scope; outer runtime remains |

Document the immutable tag and exact label, omitted-flag preservation, migration of only the known legacy official image, force-pull/validation of an omitted incompatible custom reference, replacement rollback, manual release ordering, and the fact that ordinary agent images intentionally do not contain Podman. Remove diagnostic launcher, up/update/run/cp/logs command references, marker bind-mount text, mutable-tag update instructions, and any claim that top-level stop/destroy is forwarded to core.

- [ ] **Step 5: Run graph, documentation, and reference checks**

Run:

~~~bash
node --test tests/unit/runtimeSupervisor.test.mjs tests/unit/boxPublishPlanner.test.mjs
rg -n --glob '!docs/superpowers/**' --glob '!node_modules/**' \
  --glob '!container/runtime-supervisor-tests.mjs' \
  'ploinky box|container/ploinky-box|ploinky-box\.mjs|BOX_COMMANDS|runBoxCommand|PLOINKY_PUBLIC_ENTRYPOINT' \
  bin container README.md docs
~~~

Expected: tests pass and rg returns no live/authoritative match. Internal names such as ploinky-box-demo and the image name remain allowed and are not part of this pattern.

- [ ] **Step 6: Commit smoke and documentation**

~~~bash
git add container/smoke-runtime.mjs container/runtime-supervisor-tests.mjs \
  README.md container/README.md docs/code-derived-agent-lifecycle.md \
  docs/specs/DS004-agent-manifest-and-registry.md \
  docs/specs/DS005-runtime-execution-and-isolation.md \
  docs/specs/DS008-dependency-caches-and-startup-readiness.md
git add -u container/smoke-box.mjs
git commit -m "docs: document the managed runtime supervisor"
~~~

### Task 13: Run adversarial cross-repository verification

**Files:**

- Verify only; no tracked file changes.

**Interfaces:**

- Consumes: all prior tasks and the published contract-v1 image.
- Produces: fresh evidence for static tests, unit/integration tests, real nested Podman, REPL handoff, agent boundary, and removal-surface absence.

- [ ] **Step 1: Run the complete image-repository gate**

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
bash -n images/ploinky-box/entrypoint.sh
node --test tests/image-definitions.test.mjs
git diff --check
~~~

Expected: every command exits 0.

- [ ] **Step 2: Build and exercise a local contract-v1 image**

~~~bash
cd /Users/danielsava/work/file-parser/container-image-builds
podman build \
  -f images/ploinky-box/Dockerfile \
  -t localhost/ploinky-box:podman-node24-runtime-v1-dev \
  .

test "$(podman image inspect \
  --format '{{ index .Config.Labels "io.assistos.ploinky.runtime-contract" }}' \
  localhost/ploinky-box:podman-node24-runtime-v1-dev)" = "1"

podman volume create ploinky-runtime-v1-test-deps
podman run --rm --privileged --user podman \
  --device /dev/fuse \
  --device /dev/net/tun \
  --security-opt seccomp=unconfined \
  -v /Users/danielsava/work/file-parser/ploinky:/opt/ploinky:ro \
  -v ploinky-runtime-v1-test-deps:/opt/ploinky/node_modules:U \
  localhost/ploinky-box:podman-node24-runtime-v1-dev \
  bash -lc '
    set -e
    command -v bash
    node --version | grep -E '^v24\.'
    git --version
    podman version
    podman info
    podman run --network slirp4netns:allow_host_loopback=true \
      --rm docker.io/library/alpine echo nested-ok
  '
podman volume rm ploinky-runtime-v1-test-deps

podman run --rm docker.io/assistos/ploinky-node:24-bookworm-tools \
  sh -lc '! command -v podman && ! command -v docker'
~~~

Expected: contract is 1; output includes self-check OK and nested-ok; every command exits 0; the ordinary agent image has neither container-engine command. If cleanup is needed after a failed run, remove only ploinky-runtime-v1-test-deps.

- [ ] **Step 3: Run the complete Ploinky automated gate**

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
node --check container/runtime-supervisor.mjs
bash -n bin/ploinky bin/p-cli
node --test \
  tests/unit/runtimeShell.test.mjs \
  tests/unit/inputState.test.mjs \
  tests/unit/layerIdentification.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/cliExitCodes.test.mjs \
  tests/unit/containerRuntime.test.mjs \
  tests/unit/agentReadiness.test.mjs \
  tests/unit/runtimeSupervisor.test.mjs \
  tests/unit/boxPublishPlanner.test.mjs
./tests/run-all.sh
git diff --check
~~~

Expected: syntax checks, focused tests, full suite, and diff check all exit 0.

- [ ] **Step 4: Run removal and state-mutation audits**

~~~bash
test ! -e container/ploinky-box
test ! -e container/ploinky-box.mjs
test ! -e container/ploinky-box-marker
rg -n --glob '!docs/superpowers/**' --glob '!node_modules/**' \
  --glob '!container/runtime-supervisor-tests.mjs' \
  'ploinky box|container/ploinky-box|ploinky-box\.mjs|BOX_COMMANDS|runBoxCommand|PLOINKY_PUBLIC_ENTRYPOINT' \
  bin container README.md docs
~~~

Expected: all three absence checks exit 0 and rg prints no live compatibility match.

- [ ] **Step 5: Run the real public runtime smoke**

~~~bash
cd /Users/danielsava/work/file-parser/ploinky
SMOKE_IMAGE=docker.io/assistos/ploinky-box:podman-node24-runtime-v1 \
  node container/smoke-runtime.mjs
~~~

Expected: help creates nothing; ordinary command auto-starts; inner podman version/info succeed; status succeeds; repeated stop succeeds; confirmed destroy removes the selected container and only its three volumes.

- [ ] **Step 6: Verify terminal ownership and layer banners manually**

Run from a disposable workspace:

~~~text
p-cli
cli
printf 'outer:%s:%s\n' "$USER" "$PWD"
podman version
exit
status
exit
ploinky cli
printf 'host-entry:%s:%s\n' "$USER" "$PWD"
exit
ploinky cli explorer --help
~~~

Expected:

- The outer banner names the resolved ploinky-box instance and says user=podman cwd=/workspace.
- The first shell prints outer:podman:/workspace and podman version succeeds.
- Exiting that shell restores exactly one Ploinky prompt; status runs in core scope.
- Exiting host ploinky cli returns to the host prompt.
- Explorer prints the three-line agent banner with its actual nested container and ploinky-node image.
- podman and docker remain unavailable inside Explorer unless its manifest independently changes privilege, which this plan does not do.

- [ ] **Step 7: Review the implementation against the approved design**

Read docs/superpowers/specs/2026-07-10-simplified-runtime-supervisor-cli-design.md from top to bottom. For each Goals, Host Routing, CLI and REPL Behavior, Runtime Image Contract, Automatic Reconciliation, State-Aware Commands, Removed Surface, Error Handling, Verification Contract, and Rollout row, point to a passing test or a completed manual gate. Record any unmet row as a release blocker.

## Execution Handoff

The Ploinky worktree contains pre-existing overlapping changes. The recommended execution order is:

1. Preserve and verify the current graph-driven baseline.
2. Execute Tasks 1-2 in container-image-builds.
3. Complete Manual Gate A.
4. Execute Tasks 3-12 in Ploinky with a fresh review after every commit.
5. Execute Task 13 using superpowers:verification-before-completion and the repository verify skill.

Do not publish an image, dispatch GitHub Actions, push branches, or remove any non-test runtime without the operator action specified in Manual Gate A.
