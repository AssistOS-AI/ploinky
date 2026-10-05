# Update continuation and preservation E2E

Run this gate only after an explicitly requested local Explorer deployment in the exact real directory `~/work/testExplorerFresh`. The workspace and its `.ploinky/repos` directory must already exist. The runner uses the real outer CLI and existing Box; it does not deploy or destroy a Box. No other task may change the fixture during the run.

The runner now requires a live-acceptance manifest (`--manifest`, the same strict schema and pins as `npm test -- --acceptance`). Before it creates any file, directory or Git fixture it binds that manifest to the actual running deployment (exact Box, image, source mounts, graph, active generation, repositories, Router health and a free update boundary). A deployment that is not live and ready is refused. Direct execution reports continuation-only coverage (`coverage: continuation-only` in the observations); only the `--acceptance` entrypoint reports whole acceptance. The default aggregate suite remains component-only.

```sh
node tests/e2e/updateContinueOnError/run.mjs \
  --workspace "$HOME/work/testExplorerFresh" \
  --manifest /absolute/evidence/manifest_codex.json \
  --ploinky /absolute/pushed/candidate/bin/ploinky \
  --artifacts /absolute/existing/evidence-parent/update-continuation
```

The artifact directory must be new, its parent must already exist, and it must be outside the workspace. `--ploinky` defaults to this checkout's `bin/ploinky`. Each command has a 20-minute timeout by default and the whole run, including guarded restoration, is bounded by the 3,300,000 ms schedule cap with a restoration reserve that no update may consume; `--timeout-ms` accepts 1 second through 1 hour as a per-command cap and never widens that overall bound. Each update is one owned child with a retained handle, byte-counted pipes and no signals or process groups; a command that does not settle is reported unsettled and its fixtures stay. Fixture commits use the human identity configured in the candidate checkout. The runner needs no external Git server for its injected cases, although normal updates of the deployment's existing repositories still use their configured remotes.

The runner creates local Git sources, eight managed checkout fixtures, and five skill-consumer folders. It runs `ploinky update all <owned-scenario-directory>` twice, with the working directory kept at the workspace root so a disposable folder never becomes the admitted skill scope. The generic registered-repository phase still covers the normal deployment. Unexpected errors in those repositories fail the gate instead of being accepted as fixture failures.

| Case | Required observation |
| --- | --- |
| Detached checkout | Named `detached-head` skip; HEAD, worktree and stashes preserved. |
| Staged and unstaged changes together | Named `dirty-index` skip; both staged and unstaged diffs preserved exactly. |
| Unstaged changes | Named `dirty-worktree` skip; worktree content preserved. |
| Diverged local branch | Named `diverged` skip; local commit preserved, with no rebase, reset or merge. |
| Incoming path collides with an untracked file | Named `untracked-would-be-overwritten` failure; local bytes and HEAD preserved. |
| Manifest requests another branch | Cached branch stays on `main`; prior owned skill content remains. No automatic branch switch. |
| Manifest requests a conflicting origin | Origin and HEAD stay unchanged; prior owned output remains. |
| Malformed optional manifest | Named manifest failure; later checkouts and valid manifests still run. |
| Skill removed from a verified source | Explicit selection and its owned output are pruned. Missing skills in an unverified source are not tested by this case. |
| Later clean fast-forward and valid manifest | Checkout reaches the exact advanced local upstream commit and installed skill bytes match that commit. |
| Actual optional failures | First pass exits `1`, reports partial failure and actually restarts the workspace graph: a fresh active generation with complete readiness. Output saying no running workspace required a restart is no longer accepted. |
| Unknown required membership | Second pass temporarily makes the active workspace-root skill manifest invalid. A later safe checkout still advances, but previously optional skips become required with unknown membership; exit is `1`, activation is deferred, the admitted generation is preserved, the pending-activation record identifies blockers, and the admitted skill-scope record stays unchanged. |

The second pass temporarily replaces `~/work/testExplorerFresh/ploinky-skills-manifest.json` under the canonical workspace lock. Existing bytes and mode are backed up privately in the owned source folder before injection. Symlinks, multiply linked files, and oversized files are refused. Cleanup restores the exact prior bytes or absence only when inode, device and injected content still match. If interrupted, `active-scope-restore_codex.json` in the owned source folder describes the backup for guarded recovery; do not blindly restore it over a newer edit.

Preparation and cleanup revalidate the workspace identity and take its mutation lock. Cleanup removes only directories whose inode and private ownership marker still match, and only matching test-owned source-map keys. A timeout, signal, ownership change, or lock failure retains the fixtures for inspection. Do not remove them after a timeout until the owning in-Box writer is proven terminated. The runner never removes deployment containers, agents, general Box state, or unrelated source entries.

The successful blocked-activation case deliberately leaves its truthful pending-activation record. A later verified restart/update or the final fresh fixture redeployment settles that record; the runner does not erase runtime evidence to manufacture success.

`optional-errors-stdout.log`, `optional-errors-stderr.log`, the corresponding `unknown-required-scope-*` logs, `progress.log`, and `observations_codex.json` contain sanitized output, Git snapshots, named outcomes, command exit status, pending-activation evidence, and cleanup results. Explorer health checks and the separately selected browser E2E gates remain required after this test.
