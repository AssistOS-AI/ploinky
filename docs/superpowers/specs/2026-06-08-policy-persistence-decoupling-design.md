# Policy Persistence Decoupling — Design

> **Goal:** Make the router access-control persistence layer (`cli/server/policy/`)
> swappable from the filesystem to a database **without touching domain logic**,
> using the Strategy/Adapter pattern. Pure structural refactor — all DS014 behavior
> (fail-closed, atomic writes, cached reads, audit) is preserved.
>
> **Commit policy (workspace override):** Do NOT `git commit` automatically. End at a
> logical commit point, stage the files, and ask the human to confirm.

## Problem

Two classes in `cli/server/policy/` hard-code the filesystem as their persistence
mechanism:

| Class | Persists | FS coupling |
|---|---|---|
| `PolicyStateRepository` | `policy-state.json` (`httpRoutes` + `mcpTools`) | `import fs/path`; `statSync` cache key; temp-file→`renameSync` atomic write |
| `PolicyAuditLog` | `policy-audit.log` (append-only JSONL) | `import fs/path`; `appendFileSync` |

Every other policy class (`HttpRouteWhitelist`, `McpToolPolicy`, the 7 commands) is
already storage-agnostic — it reaches persistence only through the repository's small
method surface. So the coupling is localized to these two classes.

## Approach — Strategy/Adapter on the raw-persistence seam (chosen)

Split each persistence class into **domain logic** (kept) and **raw persistence**
(delegated to an injected strategy):

- `PolicyStateRepository` keeps schema validation, indexing, the `(version)` read
  cache, the `mutate(updater)` read-modify-write transaction, and fail-closed
  semantics. It delegates only load/store of the opaque state document to a
  `PolicyStateStore`.
- `PolicyAuditLog` keeps the `ts` stamping and the "audit failures never break the
  request path" try/catch. It delegates the raw append to a `PolicyAuditSink`.

A future database backend is then a single new class per port — **no security-critical
logic is re-implemented per backend** (the rejected alternative, "make the repository
itself an interface," would duplicate validation/index/cache/`mutate` into every
adapter).

### Why this fits

`mutate(updater)` is already a backend-agnostic transaction (load → clone → apply →
validate → atomically persist). Only the `fs` stat/read/write is backend-specific, and
the `(mtime,size)` cache key generalizes to an opaque **version token** the store
provides. The seam is narrow and the change is behavior-preserving.

## Port contracts

### `PolicyStateStore`
| Method | Contract |
|---|---|
| `currentVersion()` | Cheap probe → opaque non-empty version token, or `null` when nothing is persisted. Same token ⇒ same bytes; a write must change it. Used only to cache the parsed+indexed state. |
| `read()` | `{ found: boolean, document?: object }`. Returns the persisted document already deserialized to a plain object. **Throws** on an undecodable/corrupt payload so the repository fails closed. |
| `write(document)` | Atomically replace the persisted document (a concurrent reader sees old or new, never partial). Returns the new version token. |

### `PolicyAuditSink`
| Method | Contract |
|---|---|
| `append(record)` | Durably append one already-stamped audit record. May throw; the caller (`PolicyAuditLog`) swallows errors so auditing never breaks a request. |

## Files

Create under `cli/server/policy/`:

| File | Responsibility |
|---|---|
| `PolicyStateStore.js` | Port (abstract base; methods throw "not implemented") + contract docs |
| `FileSystemPolicyStateStore.js` | FS adapter — `statSync` version, `JSON.parse` read, temp-file→`renameSync` atomic write (moved verbatim from the repository) |
| `InMemoryPolicyStateStore.js` | In-memory adapter — proves the seam, drops the tempdir/chdir dance from tests, doubles as the DB-swap template |
| `PolicyAuditSink.js` | Port (abstract base) |
| `FileSystemPolicyAuditSink.js` | FS adapter — `appendFileSync` JSONL (moved from the audit log) |

Modify:

| File | Change |
|---|---|
| `PolicyStateRepository.js` | Drop `fs`/`path`; constructor takes `{ store }` (defaults to a `FileSystemPolicyStateStore`); `_load`/`mutate` call the store |
| `PolicyAuditLog.js` | Constructor takes `{ sink }` (defaults to a `FileSystemPolicyAuditSink`); `record` delegates `append` |
| `index.js` | Composition root explicitly injects the filesystem strategies — the single place a DB swap happens later |
| `docs/specs/DS014-…md` | Update the "Persistence and Atomic Writes" paragraph + intro class list to name the pluggable store/sink; documented behavior unchanged |

## Behavior preservation (the contract that must not move)

- Default construction (`new PolicyStateRepository()` / `new PolicyAuditLog()`) keeps
  using the filesystem at the **same default paths** under `.ploinky/data/router-security/`.
  All existing call sites pass no args, so they are unaffected.
- Reads stay cached; a corrupt or schema-invalid document still **fails closed**
  (readers report `corrupt`; `mutate` throws `POLICY_PERSISTENCE_ERROR` and does not
  overwrite). Writes stay atomic.
- The repository's public surface is unchanged: `isCorrupt`, `getMcpToolEntry`,
  `listMcpTools`, `listHttpRoutes`, `getHttpRouteEntry`, `mutate`, `invalidate`.

## Test plan

- **Existing** `policyStateRepository.test.mjs` (+ `whitelistCommands`, `mcpToolPolicy`,
  `policyCommandInvoker`, `httpRouteWhitelist`) run **unchanged** against the default FS
  store — they are the behavior pins (36 currently green).
- **New** `tests/unit/policyStateStore.test.mjs`:
  - `FileSystemPolicyStateStore`: version/read/write round-trip; `null` version when
    absent; `read()` throws on bad JSON.
  - `InMemoryPolicyStateStore`: round-trip; isolation of returned clones.
  - **Seam proof:** `new PolicyStateRepository({ store: new InMemoryPolicyStateStore() })`
    satisfies the full repository contract (empty→valid, load+index, schema-invalid→
    fail-closed, `mutate` round-trip, `mutate` refuses when corrupt) **with no filesystem**.
- Run the full `tests/fast/test_all.sh` is not required (no startup/shell change); the
  policy unit suite + `npm test`-relevant unit set is.

## Out of scope

No database adapter is written now (YAGNI) — only the seam that makes one a drop-in. No
change to evaluation logic, command bus, routing, or the JSON schema.
