# Host workspace path implementation results

## Implemented behavior

The host-selected workspace `W` is mounted read-write at the same absolute path `W` in the Box. Creation supplies `--workdir W` and `PLOINKY_WORKSPACE_ROOT=W`; exact admission verifies the mount, working directory and environment. Global/development agent grants preserve the project path; isolated and static home layouts retain their existing behavior. There is no `/workspace` alias, fallback, migration, old-layout classifier or backward compatibility. `/workspace-files` remains an HTTP route.

The implementation was reviewed and finished on the isolated `feat/host-workspace-path` branch. A local image was rebuilt from the companion patch and used for real Box, WebTTY, nested Podman and lifecycle checks before committing the reviewed changes. No release image was published and no existing deployment was operated.

## Review findings fixed

| Finding | Resolution |
| --- | --- |
| Absolute file references under roots containing spaces, quotes or punctuation produced incorrect relative links. | Match the trusted root literally and preserve root-relative identity through file-index and URL handling, including Markdown links. |
| External absolute references with spaces could link a similarly named local suffix. | Reserve the complete rejected absolute-reference span so relative scanners cannot reinterpret its suffix. |
| Absolute references to literal `@name.md` files lost `@`. | Do not reapply mention-prefix normalization to already normalized root-relative paths. |
| Directory names containing template markers could be changed by later substitutions. | Substitute only original HTML placeholders in one pass and preserve escaped inserted values literally. |
| WebTTY rejected valid roots longer than 1024 bytes. | Give only the reserved workspace-root value the existing 4096-byte cwd budget; retain all other protocol limits and exact environment scrubbing. |
| Backslash roots were admitted despite runtime readers interpreting backslash as a separator. | Reject them before mutation, alongside unsupported colon/control-character paths. Spaces, Unicode, commas, quotes and shell punctuation remain supported. |
| Git diagnostics missed inaccessible intermediate absolute symlinks under a symlink-selected workspace. | Walk the projected namespace with a bounded symlink count and validate every target against the selected spelling. |
| bwrap argument generation threw because `isPathWithin` was not imported. | Restore the existing policy helper import; verify read-only code/cache grants and intentionally writable global project source. |
| Native fixtures changed `HOME` and thereby hid the local candidate in a different rootless image store. | Retain the engine's actual home; test locks keep their own explicit isolated directory. |
| Native assertions required retired managed-library generations. | Verify the current image bundle's pinned commit, source identity, exact environment and four binds; local selection still requires both read-only aliases and six binds. |
| Graphless lifecycle tests fetched optional application repositories on stop. | Prepare empty installed-repository directories from `getDefaultBootRepos()` in those fixtures. Exercise the real stop/replacement paths without fetching an application graph. |

## Verification

Evidence directory: `/home/skutner/work/file-parser/output/host-path-review-20260917`.

| Check | Result | Evidence |
| --- | --- | --- |
| Full unit suite | 4,012 tests: 3,995 passed, 1 pre-existing external-fixture failure, 16 existing skips | `final-unit/unit.tap` |
| WebTTY/WebChat/link/marketplace review tests | 363 passed before the additional external-path regression; final full unit run includes all subsequent UI fixes | `ui/unit.log`, `ui/external-absolute-regression.log` |
| Root, Git metadata and bwrap fixes | 33 passed, zero skips | `core-fixes.tap` |
| Authorization, listener inventory, CLI concurrency and local-skills prerequisites | 146 passed, zero skips | `secondary-checks.tap` |
| Packaging | 4 passed after normalizing this worktree's executable modes to 0755 | `packaging.tap` |
| Companion image definitions | 68 passed | `image-definition-tests.tap` |
| Native host path, real WebTTY and nested Podman | Passed, zero skips | `native-host-path-final.tap` |
| Native lifecycle | Six focused cases passed: same-ID stop/start with fresh tmpfs; image-cache reuse; bind-source replacement; failed-create cleanup; replacement rollback; immutable-ID removal | `native-lifecycle-storage.tap`, `native-lifecycle-rollback.tap` |
| Final combined native fixture run | 7 passed, zero failures and zero skips, with updated graphless fixtures and cleanup completed | `native-final.tap` |
| Syntax | 103 changed/added JavaScript modules checked, no failures | `syntax.json` |
| Whitespace | `git diff --check` passed | Final worktree check |

The remaining full-suite failure is `loadCatalog default workspace catalog passes validation`. The pre-existing sibling directory `/home/skutner/work/file-parser/local-llm-architectures` has no `catalog.json`; the same test failed at the baseline. That unrelated checkout was not modified and its test was not disabled or weakened. The other baseline failures were resolved by the bwrap fix and correct local file modes/umask.

The native host-path test uses a directory containing spaces, Unicode, quotes and literal shell punctuation. It proves host-to-Box-to-nested write-through, exact cwd/root environment, internal absolute symlinks, external-link confinement, absence of a fixed `/workspace` grant, both local library read-only aliases, and a real production WebTTY worker/PTY with controlled close and verified process cleanup. It starts no Explorer graph.

Early failed native attempts are retained. They exposed the engine-home mismatch, an automatically added Buildah label and stale managed-library assertions. Admission was not relaxed to accommodate any of these.

## Exact local inputs

| Input | Value |
| --- | --- |
| Ploinky baseline | `1ce77eb3ea7674d68950985ea0e2df015d6957e4` plus the reviewed changes on `feat/host-workspace-path` |
| Worktree | `/home/skutner/work/file-parser/ploinky-host-workspace-path` |
| Image source | `container-image-builds` `9a642203b9b5878d830c68a64bb8320ea627fb42` plus the companion patch |
| Companion patch SHA-256 | `b0150401618ad101b9d5b79bca65f7cdb463a2f63a170216c06b29cd38ab3a05` |
| Tested local image ID | `ccbc12e78674fc4db01af249da3ba09e6fd8efe23f6c97a2147e90a1fc4daa43` |
| Tested manifest digest | `sha256:05036277185e5e826dada9b3021f3fbe150049798297f5171f939359fb99e02f` |
| Local tag | `docker.io/assistos/ploinky-box:host-path-review-20260917-final` (not pushed) |
| AgentLib | Lock-pinned `214ba4c3d64fd857361bf8ab56a5640c5efb30e0` |
| MCP SDK | Lock-pinned `7efe9d17f52a625743e411089d3a6879f6f89156` |
| Host tools | Node.js `v24.21.0`; Linux amd64 rootless Podman `5.7.0` |

This is development verification, not release-candidate deployment evidence. The image's WebTTY build metadata uses the baseline source SHA; the actual modified source is separately identified in `build-inputs.json` and `reviewed-inputs.json`. Build inputs, the diff and added files are retained. Later review fixes are consumed through the read-only Ploinky source mount; files copied into the image did not change during review.

The Dockerfile was built locally with Podman. Its automatic `io.buildah.version` label was removed using `buildah config --unsetlabel io.buildah.version` and `buildah commit --identity-label=false`. Original filesystem layers are preserved, plus the verified empty-tar layer added by that metadata-only commit. `native-image.json` records this. For a fresh Podman build use `--identity-label=false` without cached stages containing that label; the canonical Docker Buildx publication path does not add it.

## Image integration and fresh starts

`proposals/container-image-builds-host-workspace-path.patch` updates the Dockerfile, image assertions, current image README and local RoboTeam installer. Apply it to the pinned image repository in its own checkout and build with the completed Ploinky source. The image must have static `WORKDIR /`, no baked workspace environment and the updated canonical entrypoint. Merely mounting new Ploinky source cannot replace an existing image's copied entrypoint.

Use fresh Boxes and generated runtime state. No conversion or upgrade machinery is provided. The private patched image checkout is under the evidence directory; the original deployment fixture checkout was not edited. Local test images are retained for inspection.

The concurrent image-refresh work overlaps supervisor, lifecycle and image-contract files. Preserve the dynamic `identity.workspaceRoot` argument independently of immutable image selection, and retain library read-only overlays after the writable workspace bind. Authentication work must preserve escaped WebChat root attributes, path confinement, and scrubbed WebTTY environment constructors.

Ownership, locks, credentials, rootless confinement, routing and current-layout rollback remain enforced. Explorer deployment/Playwright release gates and multi-architecture publication were not requested and were not run. All source changes remain in the isolated worktree for review and integration; the other session's checkout was not edited.
