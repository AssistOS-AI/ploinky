# Handoff: Policy Persistence Decoupling Review

## Purpose

This handoff is for reviewing a **behavior-preserving refactor** that decouples the
router access-control policy *persistence* (DS014, `cli/server/policy/`) from the
filesystem, so the store can later move to a database without touching policy logic.
The pattern used is Strategy/Adapter: each domain class keeps all of its logic and
delegates only raw I/O to an injected port.

There is **no functional/behavioral change** intended. The review's job is to confirm
(a) the decoupling is clean and correct, (b) DS014 behavior is genuinely preserved
(fail-closed, cached reads, atomic writes, default paths), and (c) no security
regression was introduced.

## ⚠️ Worktree reality — read before you `git diff`

The **entire `cli/server/policy/` directory is untracked** (`git status` shows
`?? cli/server/policy/`), as are `docs/specs/DS014-…md` and the new design doc.
**Every file in this change is untracked**, so `git diff` will NOT show this refactor —
there is no committed baseline to diff against. Review the listed files **as they
stand**, against the design intent and the behavior-preservation claim below. The
behavior-preservation evidence is that the *pre-existing* policy tests
(`policyStateRepository.test.mjs` and the others) pass **unchanged** against the
default filesystem store.

The broader worktree also contains a large, unrelated per-agent-security branch
(DS013/DS014 work). Do not try to review that as part of this change — focus only on
the files below.

## What Changed

Two domain classes were split into **domain logic (kept)** + **raw persistence
(delegated to an injected strategy)**:

| Area | Change |
| --- | --- |
| State persistence port | New `PolicyStateStore` port: `currentVersion()` (opaque version token, or `null` when nothing persisted), `read()` (deserialized document; **throws** on an undecodable payload), `write(document)` (atomic replace, returns new token). |
| State adapters | New `FileSystemPolicyStateStore` (the original fs mechanism — `statSync` version, temp-file→`renameSync`, `mkdirSync` — moved verbatim) and `InMemoryPolicyStateStore` (non-persistent; proves the seam, doubles as the DB-adapter template). |
| Repository | `PolicyStateRepository` no longer imports `node:fs`/`node:path`. It keeps **all** schema validation, indexing, the read cache, the `mutate` read-modify-write transaction, and the fail-closed rules, and delegates load/store to the injected store. Constructor changed from `{ file }` (which had no callers) to `{ store }`, defaulting to a `FileSystemPolicyStateStore`. |
| Audit port + adapter | New `PolicyAuditSink` port (`append(record)`) and `FileSystemPolicyAuditSink` (the JSONL append, moved verbatim). `PolicyAuditLog` keeps the `ts` stamping + never-throw guarantee and delegates the append; constructor takes `{ sink }` (defaults to fs) and still accepts `{ dir }` (passed through to the default sink). |
| Composition root | `index.js` now explicitly injects `new FileSystemPolicyStateStore()` / `new FileSystemPolicyAuditSink()` — the single place the persistence strategy is chosen (where a DB swap would happen). |
| Tests | New `tests/unit/policyStateStore.test.mjs` covers both adapters directly and the seam (the repository's full contract over a non-filesystem store). The existing policy tests are unchanged. |
| Specs/docs | `DS014` persistence section + intro + a new Q5 rationale now describe the pluggable store/sink. A design note was added under `docs/superpowers/specs/`. |

## Primary Files To Review

| File | Status | Why it matters |
| --- | --- | --- |
| `cli/server/policy/PolicyStateRepository.js` | modified (untracked tree) | The domain layer. Confirm it is fs-free and that cache + fail-closed + `mutate` semantics are intact. **Highest-signal file.** |
| `cli/server/policy/PolicyStateStore.js` | new | The state persistence port + contract docs. |
| `cli/server/policy/FileSystemPolicyStateStore.js` | new | The fs adapter. Confirm temp→rename atomicity and `read()` throwing on bad JSON were preserved exactly. |
| `cli/server/policy/InMemoryPolicyStateStore.js` | new | The in-memory adapter / DB-swap template. Confirm clone isolation. |
| `cli/server/policy/PolicyAuditLog.js` | modified (untracked tree) | The audit domain layer. Confirm it is fs-free and still never throws into the request path. |
| `cli/server/policy/PolicyAuditSink.js` | new | The audit port. |
| `cli/server/policy/FileSystemPolicyAuditSink.js` | new | The fs audit adapter. |
| `cli/server/policy/index.js` | modified (untracked tree) | Composition root wiring. Confirm the fs strategies are injected and nothing else changed. |
| `tests/unit/policyStateStore.test.mjs` | new | The seam proof + adapter tests. Confirm they would fail if the decoupling broke fail-closed or the seam. |
| `docs/specs/DS014-router-access-control-http-whitelist-and-mcp-policy.md` | modified (untracked) | Persistence section + intro + Q5. Confirm docs match the implementation. |
| `docs/superpowers/specs/2026-06-08-policy-persistence-decoupling-design.md` | new | The design rationale and the rejected alternative. Useful as the "intent" reference. |

## Review Focus

| Area | Questions |
| --- | --- |
| Behavior preserved | The read cache key dropped its `${file}` prefix (now just the store's `${mtimeMs}:${size}` token). For a repository bound to one fixed file, is this provably equivalent across: missing-file→empty, file-appears-after-absent, `mutate`→reread, two unchanged reads? |
| Fail-closed | Does the repository fail closed on **both** a throw from `store.read()` (bad bytes) **and** a `validateState` failure (bad schema)? Does `mutate` throw `POLICY_PERSISTENCE_ERROR` and not overwrite a corrupt document? Does `FileSystemPolicyStateStore.read()` actually throw on bad JSON? |
| Atomic write | Are `mkdirSync` + temp-file→`renameSync` preserved (now inside the fs adapter, not the repository)? Nothing lost in the move? |
| Backward compat | Every call site uses the no-arg constructor (`new PolicyStateRepository()` / `new PolicyAuditLog()`). Does the no-arg path still default to the filesystem at the same `.ploinky/data/router-security/` paths? Does `PolicyAuditLog({ dir })` still work? |
| Residual coupling | Are `PolicyStateRepository.js` and `PolicyAuditLog.js` truly free of `node:fs`/`node:path` and any fs calls? Is the only domain→adapter coupling the default-construction `|| new FileSystem…()` (acceptable), with the composition root doing explicit injection? |
| Design quality | Is the port contract right (sync, document-as-object, opaque version token)? Is `mutate(updater)` still a backend-agnostic transaction a DB could implement? Is anything leaking a filesystem assumption into the port? |
| Test adequacy | Do the new tests exercise the seam (repository over a non-fs store) and both fail-closed branches, or are they shallow? Would they fail if the decoupling regressed? |

## Verification Already Run

From `/Users/danielsava/work/file-parser/ploinky`:

```bash
node --test tests/unit/policyStateStore.test.mjs tests/unit/policyStateRepository.test.mjs tests/unit/whitelistCommands.test.mjs tests/unit/mcpToolPolicy.test.mjs tests/unit/policyCommandInvoker.test.mjs tests/unit/httpRouteWhitelist.test.mjs
```

Result: 43 tests, 43 pass (36 pre-existing + 7 new).

```bash
node --test tests/unit/*.test.mjs
```

Result: 569 tests, 569 pass (no regressions across the full unit suite).

```bash
node -e "import('./cli/server/policy/index.js').then(p=>console.log('isCorrupt:', p.default.repository.isCorrupt()))"
```

Result: composition root loads; `isCorrupt: false`.

An adversarial pass (a fresh-context `implementation-verifier` agent) probed the cache
key, fail-closed (read-throw + schema-invalid), atomic write, backward-compat default
paths, and residual coupling with throwaway scripts, and returned **VERDICT: PASS**.

## Worktree Notes

No files were staged or committed as part of this change or this handoff. This subrepo
carries a workspace commit override (see
`docs/superpowers/plans/2026-06-05-whitelist-command-oop.md`): do not `git commit`
automatically — stage and let the human confirm.
