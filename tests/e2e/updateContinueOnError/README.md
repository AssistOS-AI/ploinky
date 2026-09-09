# Update continuation E2E

Run this gate after the explicitly requested fresh Explorer deployment in the exact real directory `~/work/testExplorerFresh`. The workspace and its existing `.ploinky/repos` directory must already exist. The runner does not deploy or destroy a Box. Run it while no other task is changing that fixture.

```sh
node tests/e2e/updateContinueOnError/run.mjs \
  --workspace "$HOME/work/testExplorerFresh" \
  --ploinky /absolute/pushed/candidate/bin/ploinky \
  --artifacts /absolute/existing/evidence-parent/update-continuation
```

The artifact directory must not exist, its parent must already exist, and it must be outside the workspace. `--ploinky` defaults to this checkout's `bin/ploinky`. The default command timeout is 20 minutes; `--timeout-ms` accepts 1 second through 1 hour. Fixture Git commits use the human name and email configured for the selected candidate checkout.

The runner prepares uniquely named local sources under `.update-e2e-<runId>`, skills-only managed caches, and four visible manifest folders. It seeds the prior installed `main` skill and a cache on `main`, then changes the manifest to request `feature`. Cache origins use `/workspace/...`, the same workspace mount used by the actual Box. It invokes the real outer `ploinky update` exactly once.

The gate requires exit status zero and exactly three detailed errors: a detached managed checkout, a manifest with a conflicting source URL, and a manifest requesting a missing skill. It checks that a later checkout advances, the shared skill changes to the feature version, the conflicting cache retains its origin and commit, and a later valid manifest installs. Any unrelated update failure also fails the gate.

Preparation and cleanup use the canonical workspace mutation lock. Cleanup checks the workspace identity, each owned directory's inode and private marker, and any source-map keys before removing them. It preserves unrelated directories and source-map entries. An ownership or lock failure stops cleanup and leaves evidence for inspection. The runner never removes the deployment, agents, or general Box state.

`stdout.log`, `stderr.log`, `progress.log`, and `observations.json` retain sanitized command output, source/cache identities before cleanup, assertions, and cleanup results. The required Explorer health and three Playwright release gates remain separate checks.
