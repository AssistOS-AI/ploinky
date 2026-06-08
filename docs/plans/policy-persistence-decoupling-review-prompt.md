# Codex Review Prompt: Policy Persistence Decoupling

You are reviewing uncommitted changes in:

```text
/Users/danielsava/work/file-parser/ploinky
```

Perform a code-review pass on a **behavior-preserving refactor** that decouples the
router access-control policy *persistence* (DS014, `cli/server/policy/`) from the
filesystem using the Strategy/Adapter pattern, so a database can replace the JSON file
later without touching policy logic.

Read this handoff first:

```text
docs/plans/policy-persistence-decoupling-review-handoff.md
```

## ⚠️ Important: this change is entirely in UNTRACKED files

`git status` shows `?? cli/server/policy/` and `?? docs/specs/DS014-…md` — the whole
policy tree and the spec are untracked, so **`git diff` will show none of this change**
and there is no committed baseline to diff against. Review the files **as they stand**
against the design intent and the behavior-preservation claim. Do not try to review the
broader per-agent-security branch in the same worktree; focus only on the files below.

Review these files (primary first):

```text
cli/server/policy/PolicyStateRepository.js        # domain layer — must be fs-free; highest signal
cli/server/policy/PolicyStateStore.js             # state persistence port
cli/server/policy/FileSystemPolicyStateStore.js   # fs adapter (atomicity, read-throws-on-bad-JSON)
cli/server/policy/InMemoryPolicyStateStore.js     # in-memory adapter / DB template
cli/server/policy/PolicyAuditLog.js               # audit domain layer — must be fs-free, never throws
cli/server/policy/PolicyAuditSink.js              # audit port
cli/server/policy/FileSystemPolicyAuditSink.js    # fs audit adapter
cli/server/policy/index.js                        # composition root wiring
tests/unit/policyStateStore.test.mjs              # seam proof + adapter tests
docs/specs/DS014-router-access-control-http-whitelist-and-mcp-policy.md
docs/superpowers/specs/2026-06-08-policy-persistence-decoupling-design.md   # intent reference
```

Use a strict review stance. Do not implement fixes unless explicitly asked. Lead with
findings ordered by severity, with file/line references. If there are no findings, say
so clearly and call out residual risks or test gaps.

## Review goal

Verify that the refactor preserves **all** DS014 persistence behavior — fail-closed on
corrupt/invalid state, cached reads, atomic writes, and the same default on-disk paths —
while moving every `node:fs`/`node:path` use out of the two domain classes
(`PolicyStateRepository`, `PolicyAuditLog`) and behind injectable ports
(`PolicyStateStore`, `PolicyAuditSink`). A future database must be implementable as one
adapter per port with no change to the fail-closed logic, the command bus,
`HttpRouteWhitelist`, or `McpToolPolicy`.

## Specific things to check

| Area | Review question |
| --- | --- |
| Residual coupling | Are `PolicyStateRepository.js` and `PolicyAuditLog.js` free of `node:fs`/`node:path` and all fs calls? Is the only domain→concrete reference the default-construction fallback `|| new FileSystem…()`, with `index.js` doing the real injection? |
| Cache equivalence | The read cache key changed from `${file}:${mtimeMs}:${size}` to just `${mtimeMs}:${size}`. Argue whether this can ever cause a stale or wrong read for a repository bound to one fixed file. Check the empty-state branch sets a key (`''`) that can never collide with a real stat token, so a file appearing after absence is always re-read. |
| Fail-closed (two sources) | Does `_load()` catch **both** a throw from `store.read()` and a `validateState()` failure, marking the cache `corrupt`? Does `FileSystemPolicyStateStore.read()` genuinely throw on undecodable JSON? Does `mutate()` check `loaded.ok` and throw `POLICY_PERSISTENCE_ERROR` before any write, leaving the document untouched? |
| Atomic write moved intact | Does `FileSystemPolicyStateStore.write()` still `mkdirSync(dir,{recursive:true})`, write a same-directory temp file, `renameSync` over the target, and return a fresh version? Was anything dropped relative to the old in-repository write? |
| Port contract soundness | Is the `PolicyStateStore` contract coherent (synchronous; `document` is a plain object; `currentVersion()` returns an opaque non-empty token or `null`; `write` is an atomic replace)? Could a DB adapter satisfy it without leaking filesystem assumptions? Is `mutate(updater)` still backend-agnostic? |
| Backward compat | Confirm every call site uses the no-arg constructor and that the no-arg default still resolves to `.ploinky/data/router-security/policy-state.json` (and the audit dir). Confirm `PolicyAuditLog({ dir })` still routes to the default sink. |
| Audit never fatal | Does `PolicyAuditLog.record()` still swallow sink errors so an audit failure never breaks a request? Is the `ts` stamp still applied before the record reaches the sink? |
| Test strength | Would `policyStateStore.test.mjs` fail if the repository stopped failing closed, if `read()` stopped throwing on bad JSON, or if the in-memory store returned shared (non-cloned) references? Does it actually run the repository over a non-filesystem store? |
| Docs match code | Do the DS014 persistence paragraph, intro class list, and Q5 accurately describe the implemented store/sink seam? |

## Run these checks if the local environment permits

```bash
cd /Users/danielsava/work/file-parser/ploinky

# New seam tests + the unchanged pre-existing policy tests (behavior pins):
node --test tests/unit/policyStateStore.test.mjs tests/unit/policyStateRepository.test.mjs tests/unit/whitelistCommands.test.mjs tests/unit/mcpToolPolicy.test.mjs tests/unit/policyCommandInvoker.test.mjs tests/unit/httpRouteWhitelist.test.mjs

# Full unit suite — confirm no regression elsewhere:
node --test tests/unit/*.test.mjs

# Composition root loads and the policy layer is wired:
node -e "import('./cli/server/policy/index.js').then(p=>console.log('isCorrupt:', p.default.repository.isCorrupt())).catch(e=>{console.error(e);process.exit(1)})"

# The two domain classes must be filesystem-free:
rg -n "node:fs|node:path|statSync|readFileSync|writeFileSync|mkdirSync|renameSync|appendFileSync" cli/server/policy/PolicyStateRepository.js cli/server/policy/PolicyAuditLog.js || echo "OK: domain classes are fs-free"
```

Expected: 43/43 then 569/569 tests pass; `isCorrupt: false`; the `rg` prints `OK: domain classes are fs-free`.

## When reporting, include

| Section | Content |
| --- | --- |
| Findings | Bugs, security gaps, regressions, behavior divergences from the pre-refactor semantics, missing tests, or doc/implementation mismatches — ordered by severity, with file/line references. |
| Open questions | Only questions that materially affect correctness. |
| Verification | Exact commands run and pass/fail output summary. |
| Residual risk | Anything acceptable but worth tracking (e.g. the stat-based version token's same-mtime+same-size collision window for *external* writers, which is inherited from the original design, not introduced here). |

Do not stage, commit, or rewrite any worktree changes.
