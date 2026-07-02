# Remote LLM Catalog Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ploinky retrieve the LLM architecture catalog from an explicit path, an explicit remote repo/ref, or the built-in default remote repo/cache, with no implicit sibling checkout fallback.

**Architecture:** Keep catalog validation in `llmArchitectureCatalog.js`, but replace the default sibling path with a remote catalog resolver that clones/fetches into `.ploinky/llm-catalog-cache`. Propagate catalog provenance through architecture selection and selected runtime state so operators can see source, repo URL, requested ref, and resolved commit.

**Tech Stack:** Node.js ESM, built-in `node:test`, filesystem APIs, `child_process.execFileSync`, Git CLI, existing Ploinky LLM runtime services.

---

## Source Specs

Implement against these committed specs:

- `docs/superpowers/specs/2026-07-02-remote-llm-architecture-catalog-design.md`
- `docs/specs/DS012-local-llm-agent-architecture-catalog.md`

The required behavior is:

| Requirement | Implementation Target |
| --- | --- |
| Explicit local path wins | `PLOINKY_LLM_ARCHITECTURES_PATH` remains first priority. |
| Explicit remote repo/ref wins after path | `PLOINKY_LLM_ARCHITECTURES_REPO` plus optional `PLOINKY_LLM_ARCHITECTURES_REF`. |
| Built-in default remote is last | `https://github.com/AssistOS-AI/local-llm-architectures.git` at `main`. |
| No sibling checkout fallback | Remove `../local-llm-architectures` default behavior. |
| Cache remote catalogs | Use `.ploinky/llm-catalog-cache/<hash-of-repo-and-ref>` by default. |
| Reuse valid cache on update failure | If a cached checkout exists and remote fetch fails, use the cached checkout after validation. |
| Fail clearly on first-run fetch failure | Error message names source and override env vars. |
| Record provenance | Selected state includes catalog `id`, `ref`, `source`, `repoUrl`, `requestedRef`. |
| Preserve validation boundary | Catalog remains JSON-only data; existing validation stays strict. |

## File Structure

| File | Responsibility |
| --- | --- |
| `cli/services/llmArchitectureCatalog.js` | Resolve catalog source, fetch/cache remote catalogs, validate catalog files, return provenance. |
| `cli/services/llmArchitectureSelector.js` | Include catalog provenance in selection result. |
| `cli/services/llmRuntimeIntegration.js` | Write catalog provenance to `selected-architecture.json` and include it in reuse hashing. |
| `tests/unit/llmArchitectureCatalog.test.mjs` | Test path, explicit remote, default remote, cache fallback, and first-run failure behavior. |
| `tests/unit/llmArchitectureSelector.test.mjs` | Test selection result carries catalog provenance. |
| `tests/unit/llmRuntimeIntegration.test.mjs` | Test selected state and reuse key carry catalog provenance without secrets. |

Do not stage or modify `node_modules/achillesAgentLib`.

## Parallelization Notes

Task 1 and Task 4 are test-writing tasks and can be prepared in parallel by separate agents if they coordinate on field names:

- `catalogSource`
- `catalogRepoUrl`
- `catalogRequestedRef`

Task 2 must land before the catalog retrieval tests can pass. Task 5 must land before selector/integration provenance tests can pass. Task 7 is the final gate.

### Task 1: Write Failing Catalog Retrieval Tests

**Files:**
- Modify: `tests/unit/llmArchitectureCatalog.test.mjs`

- [ ] **Step 1: Add test imports**

At the top of `tests/unit/llmArchitectureCatalog.test.mjs`, after existing imports, add:

```js
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
```

Extend the existing import from `../../cli/services/llmArchitectureCatalog.js` to include the new exports that will be implemented in Task 2:

```js
import {
    CATALOG_VALIDATION_CONTRACT,
    CatalogValidationError,
    DEFAULT_CATALOG_REF,
    DEFAULT_CATALOG_REPO_URL,
    loadCatalog,
    resolveCatalogRootFromEnv,
    validateRuntimePolicy,
    validateArchitectureRecord,
    validateImageRecord,
} from '../../cli/services/llmArchitectureCatalog.js';
```

- [ ] **Step 2: Add Git helper functions**

After `makeValidCatalog(rootPath)`, add:

```js
function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function fileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

function initGitCatalog(rootPath, branch = 'main') {
    makeValidCatalog(rootPath);
    git(['init', '--quiet', '-b', branch], rootPath);
    git(['config', 'user.email', 'catalog-tests@example.invalid'], rootPath);
    git(['config', 'user.name', 'Catalog Tests'], rootPath);
    git(['add', '.'], rootPath);
    git(['commit', '--quiet', '-m', 'catalog'], rootPath);
    return git(['rev-parse', 'HEAD'], rootPath);
}
```

- [ ] **Step 3: Write test for explicit path precedence**

Add this test before the existing `loadCatalog accepts a valid catalog with required relationships` test:

```js
test('loadCatalog uses explicit path before any remote source', () => {
    const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-path-first-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-'));
    try {
        makeValidCatalog(catalogRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_ARCHITECTURES_REPO: 'file:///does/not/exist',
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });

        assert.equal(result.source, 'path');
        assert.equal(result.repoUrl, null);
        assert.equal(result.requestedRef, null);
        assert.equal(result.catalogRoot, path.resolve(catalogRoot));
        assert.equal(result.catalogId, 'test/catalog');
    } finally {
        fs.rmSync(catalogRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 4: Write test for explicit remote clone**

Add:

```js
test('loadCatalog clones configured remote catalog into cache', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-cache-'));
    try {
        const commit = initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });

        assert.equal(result.source, 'git');
        assert.equal(result.repoUrl, repoUrl);
        assert.equal(result.requestedRef, 'main');
        assert.equal(result.catalogRef, commit);
        assert.equal(result.catalogId, 'test/catalog');
        assert.ok(result.catalogRoot.startsWith(path.resolve(cacheDir)));
        assert.ok(fs.existsSync(path.join(result.catalogRoot, '.git')));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 5: Write test for default remote clone without network**

Add:

```js
test('loadCatalog clones default remote catalog when no path or repo env is set', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-cache-'));
    try {
        const commit = initGitCatalog(sourceRoot, DEFAULT_CATALOG_REF);
        const repoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
            defaultRepoUrl: repoUrl,
            defaultRef: DEFAULT_CATALOG_REF,
        });

        assert.equal(DEFAULT_CATALOG_REPO_URL, 'https://github.com/AssistOS-AI/local-llm-architectures.git');
        assert.equal(DEFAULT_CATALOG_REF, 'main');
        assert.equal(result.source, 'default-remote');
        assert.equal(result.repoUrl, repoUrl);
        assert.equal(result.requestedRef, 'main');
        assert.equal(result.catalogRef, commit);
        assert.equal(result.catalogId, 'test/catalog');
        assert.ok(result.catalogRoot.startsWith(path.resolve(cacheDir)));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 6: Write test for cached checkout fallback after fetch failure**

Add:

```js
test('loadCatalog uses existing cached checkout when remote update fails', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-src-'));
    const removedRoot = `${sourceRoot}.removed`;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-dir-'));
    try {
        const commit = initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const first = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });
        assert.equal(first.catalogRef, commit);

        fs.renameSync(sourceRoot, removedRoot);

        const second = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });
        assert.equal(second.source, 'git');
        assert.equal(second.repoUrl, repoUrl);
        assert.equal(second.requestedRef, 'main');
        assert.equal(second.catalogRef, commit);
        assert.equal(second.catalogRoot, first.catalogRoot);
        assert.equal(second.catalogId, 'test/catalog');
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(removedRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 7: Write test for first-run remote failure**

Add:

```js
test('loadCatalog fails clearly when remote catalog cannot be fetched and no cache exists', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-empty-cache-'));
    try {
        assert.throws(
            () => loadCatalog({
                env: {
                    PLOINKY_LLM_ARCHITECTURES_REPO: 'file:///path/that/does/not/exist',
                    PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                    PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
                },
            }),
            (err) => err instanceof CatalogValidationError
                && /Unable to fetch LLM architecture catalog/.test(err.message)
                && /PLOINKY_LLM_ARCHITECTURES_PATH/.test(err.message)
                && /PLOINKY_LLM_ARCHITECTURES_REPO/.test(err.message),
        );
    } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 8: Write test for resolver metadata without loading catalog files**

Add:

```js
test('resolveCatalogRootFromEnv returns default-remote metadata for the built-in source', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-resolve-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-resolve-cache-'));
    try {
        initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const resolved = resolveCatalogRootFromEnv({
            PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
        }, {
            defaultRepoUrl: repoUrl,
            defaultRef: 'main',
        });

        assert.equal(resolved.source, 'default-remote');
        assert.equal(resolved.repoUrl, repoUrl);
        assert.equal(resolved.requestedRef, 'main');
        assert.ok(resolved.rootPath.startsWith(path.resolve(cacheDir)));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});
```

- [ ] **Step 9: Run catalog tests and confirm the expected failures**

Run:

```bash
node --test tests/unit/llmArchitectureCatalog.test.mjs
```

Expected before implementation: FAIL because `DEFAULT_CATALOG_REF`, `DEFAULT_CATALOG_REPO_URL`, and remote/default resolver behavior do not exist yet.

### Task 2: Implement Remote Catalog Retrieval

**Files:**
- Modify: `cli/services/llmArchitectureCatalog.js`
- Test: `tests/unit/llmArchitectureCatalog.test.mjs`

- [ ] **Step 1: Replace sibling-path constants with remote defaults**

In `cli/services/llmArchitectureCatalog.js`, remove:

```js
import { fileURLToPath } from 'url';
```

Remove:

```js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CATALOG_PATH = path.join(REPO_ROOT, 'local-llm-architectures');
```

Add in the same constants area:

```js
const DEFAULT_CATALOG_REPO_URL = 'https://github.com/AssistOS-AI/local-llm-architectures.git';
const DEFAULT_CATALOG_REF = 'main';
```

- [ ] **Step 2: Add remote helper functions**

Replace the current `ensureRemoteClone(repoUrl, ref, cacheDir)` function with the following functions:

```js
function validateCatalogRepoUrl(repoUrl, label = 'PLOINKY_LLM_ARCHITECTURES_REPO') {
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(repoUrl)) {
        throw new CatalogValidationError(`${label}: unsupported URL scheme`);
    }
}

function catalogCacheKey(repoUrl, ref) {
    return crypto.createHash('sha256')
        .update(`${repoUrl}#${ref || DEFAULT_CATALOG_REF}`)
        .digest('hex')
        .slice(0, 16);
}

function runGit(args, label) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        const message = stderr || err.message || 'git command failed';
        throw new CatalogValidationError(`${label}: ${message}`, { cause: err });
    }
}

function hasGitCheckout(target) {
    return fs.existsSync(path.join(target, '.git'));
}

function remoteFetchFailureMessage(repoUrl, ref, cacheDir) {
    return [
        `Unable to fetch LLM architecture catalog from ${repoUrl}#${ref}.`,
        `Set PLOINKY_LLM_ARCHITECTURES_PATH to use a local catalog checkout,`,
        `or set PLOINKY_LLM_ARCHITECTURES_REPO/PLOINKY_LLM_ARCHITECTURES_REF to a reachable remote.`,
        `Cache directory: ${cacheDir}`,
    ].join(' ');
}

function initializeRemoteCheckout(target, repoUrl, ref) {
    fs.mkdirSync(target, { recursive: true });
    runGit(['-C', target, 'init', '--quiet'], `git init catalog cache`);
    runGit(['-C', target, 'remote', 'add', 'origin', repoUrl], `git remote add catalog origin`);
    runGit(['-C', target, 'fetch', '--quiet', '--depth', '1', 'origin', ref], `git fetch catalog ${ref}`);
    runGit(['-C', target, 'checkout', '--quiet', 'FETCH_HEAD'], `git checkout catalog ${ref}`);
}

function updateRemoteCheckout(target, repoUrl, ref) {
    runGit(['-C', target, 'remote', 'set-url', 'origin', repoUrl], `git remote set-url catalog origin`);
    runGit(['-C', target, 'fetch', '--quiet', '--depth', '1', 'origin', ref], `git fetch catalog ${ref}`);
    runGit(['-C', target, 'checkout', '--quiet', 'FETCH_HEAD'], `git checkout catalog ${ref}`);
}

function ensureRemoteCatalog({ repoUrl, ref, cacheDir, source }) {
    validateCatalogRepoUrl(repoUrl);
    const requestedRef = String(ref || DEFAULT_CATALOG_REF).trim() || DEFAULT_CATALOG_REF;
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, catalogCacheKey(repoUrl, requestedRef));
    const hadCache = hasGitCheckout(target);
    const tmpTarget = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
        if (hadCache) {
            updateRemoteCheckout(target, repoUrl, requestedRef);
        } else {
            fs.rmSync(tmpTarget, { recursive: true, force: true });
            initializeRemoteCheckout(tmpTarget, repoUrl, requestedRef);
            fs.rmSync(target, { recursive: true, force: true });
            fs.renameSync(tmpTarget, target);
        }
    } catch (err) {
        fs.rmSync(tmpTarget, { recursive: true, force: true });
        if (hadCache && hasGitCheckout(target)) {
            return {
                rootPath: target,
                source,
                repoUrl,
                requestedRef,
                cacheDir,
                fetchStatus: 'cached-after-fetch-failure',
            };
        }
        throw new CatalogValidationError(
            remoteFetchFailureMessage(repoUrl, requestedRef, cacheDir),
            { repoUrl, requestedRef, cacheDir, cause: err }
        );
    }

    return {
        rootPath: target,
        source,
        repoUrl,
        requestedRef,
        cacheDir,
        fetchStatus: 'updated',
    };
}
```

- [ ] **Step 3: Update `resolveCatalogRootFromEnv` source ordering**

Replace the full `resolveCatalogRootFromEnv(env, options = {})` function with:

```js
function resolveCatalogRootFromEnv(env, options = {}) {
    const explicitPath = String(env.PLOINKY_LLM_ARCHITECTURES_PATH || '').trim();
    const repoUrl = String(env.PLOINKY_LLM_ARCHITECTURES_REPO || '').trim();
    const requestedRef = String(env.PLOINKY_LLM_ARCHITECTURES_REF || '').trim()
        || String(options.defaultRef || DEFAULT_CATALOG_REF).trim()
        || DEFAULT_CATALOG_REF;
    const cacheDir = String(env.PLOINKY_LLM_CATALOG_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;

    if (explicitPath) {
        const resolved = path.isAbsolute(explicitPath)
            ? explicitPath
            : path.resolve(PLOINKY_WORKSPACE_ROOT, explicitPath);
        return {
            rootPath: resolved,
            source: 'path',
            repoUrl: null,
            requestedRef: null,
            cacheDir,
            fetchStatus: 'not-needed',
        };
    }

    if (repoUrl) {
        return ensureRemoteCatalog({
            repoUrl,
            ref: requestedRef,
            cacheDir,
            source: 'git',
        });
    }

    const defaultRepoUrl = String(options.defaultRepoUrl || DEFAULT_CATALOG_REPO_URL).trim();
    const defaultRef = String(options.defaultRef || DEFAULT_CATALOG_REF).trim() || DEFAULT_CATALOG_REF;
    return ensureRemoteCatalog({
        repoUrl: defaultRepoUrl,
        ref: defaultRef,
        cacheDir,
        source: 'default-remote',
    });
}
```

- [ ] **Step 4: Update `loadCatalog` to remove `defaultPath`**

Replace the resolver call in `loadCatalog(options = {})`:

```js
const resolved = resolveCatalogRootFromEnv(env, {
    defaultPath: options.defaultPath || DEFAULT_CATALOG_PATH,
});
if (!resolved) {
    throw new CatalogValidationError(
        'No local-llm-architectures catalog found. Set PLOINKY_LLM_ARCHITECTURES_PATH, PLOINKY_LLM_ARCHITECTURES_REPO, '
        + 'or place a catalog at the workspace default path.'
    );
}
```

with:

```js
const resolved = resolveCatalogRootFromEnv(env, {
    defaultRepoUrl: options.defaultRepoUrl || DEFAULT_CATALOG_REPO_URL,
    defaultRef: options.defaultRef || DEFAULT_CATALOG_REF,
});
```

Update the destructuring later in `loadCatalog` from:

```js
const { rootPath, source, repoUrl, requestedRef, cacheDir } = resolved;
```

to:

```js
const { rootPath, source, repoUrl, requestedRef, cacheDir, fetchStatus } = resolved;
```

Add `fetchStatus` to the returned object:

```js
fetchStatus,
```

- [ ] **Step 5: Export remote constants and helper**

Replace the export block:

```js
    DEFAULT_CATALOG_PATH,
```

with:

```js
    DEFAULT_CATALOG_REF,
    DEFAULT_CATALOG_REPO_URL,
```

Add this export as well:

```js
    resolveCatalogRootFromEnv,
```

Keep the existing `resolveCatalogRootFromEnv` export if it is already present.

- [ ] **Step 6: Run catalog tests**

Run:

```bash
node --test tests/unit/llmArchitectureCatalog.test.mjs
```

Expected after implementation: PASS. The output should include all catalog tests with `fail 0`.

- [ ] **Step 7: Commit catalog retrieval implementation**

Run:

```bash
git add cli/services/llmArchitectureCatalog.js tests/unit/llmArchitectureCatalog.test.mjs
git commit -m "Implement remote LLM catalog retrieval"
```

Expected: one commit on `llm-runtime-containers`.

### Task 3: Remove Sibling-Fallback Test Assumption

**Files:**
- Modify: `tests/unit/llmArchitectureCatalog.test.mjs`
- Test: `tests/unit/llmArchitectureCatalog.test.mjs`

- [ ] **Step 1: Rename the workspace-catalog validation test**

Find the test currently named:

```js
test('loadCatalog default workspace catalog passes validation', () => {
```

Rename it to:

```js
test('local workspace catalog passes validation when explicitly configured by path', () => {
```

- [ ] **Step 2: Keep the explicit path assertion**

Ensure the body still uses:

```js
const result = loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: defaultCatalogPath } });
assert.equal(result.source, 'path');
```

If `assert.equal(result.source, 'path');` is absent, add it immediately after `loadCatalog`.

- [ ] **Step 3: Run catalog tests**

Run:

```bash
node --test tests/unit/llmArchitectureCatalog.test.mjs
```

Expected: PASS with `fail 0`.

- [ ] **Step 4: Commit the test wording cleanup**

Run:

```bash
git add tests/unit/llmArchitectureCatalog.test.mjs
git commit -m "Clarify local LLM catalog path test"
```

Expected: one commit on `llm-runtime-containers`.

### Task 4: Write Failing Provenance Propagation Tests

**Files:**
- Modify: `tests/unit/llmArchitectureSelector.test.mjs`
- Modify: `tests/unit/llmRuntimeIntegration.test.mjs`

- [ ] **Step 1: Add selector provenance assertion**

In `tests/unit/llmArchitectureSelector.test.mjs`, find the test that selects a CPU or NVIDIA catalog architecture successfully. Add these fields to the catalog fixture used by that test:

```js
catalogRef: 'abc123catalogref',
source: 'git',
repoUrl: 'https://example.invalid/local-llm-architectures.git',
requestedRef: 'main',
```

Then add these assertions after `selectArchitecture(...)` returns:

```js
assert.equal(result.catalogSource, 'git');
assert.equal(result.catalogRepoUrl, 'https://example.invalid/local-llm-architectures.git');
assert.equal(result.catalogRequestedRef, 'main');
```

Expected before Task 5: FAIL because the selection result does not expose these fields.

- [ ] **Step 2: Add selected-state provenance assertions**

In `tests/unit/llmRuntimeIntegration.test.mjs`, inside `prepareLlmStartup selects catalog architecture and writes state file`, add these assertions after:

```js
assert.equal(stateJson.catalog.id, 'test/catalog');
```

Add:

```js
assert.equal(stateJson.catalog.source, 'path');
assert.equal(stateJson.catalog.repoUrl, null);
assert.equal(stateJson.catalog.requestedRef, null);
```

Also add reuse-key assertions after `assert.equal(result.reuseHash, computeReuseHashForTest(result.reuseKey));`:

```js
assert.equal(result.reuseKey.catalogSource, 'path');
assert.equal(result.reuseKey.catalogRepoUrl, null);
assert.equal(result.reuseKey.catalogRequestedRef, null);
```

Expected before Task 5: FAIL because selected state and reuse key do not expose these fields.

- [ ] **Step 3: Run focused provenance tests and confirm failure**

Run:

```bash
node --test tests/unit/llmArchitectureSelector.test.mjs tests/unit/llmRuntimeIntegration.test.mjs
```

Expected before implementation: FAIL with missing or `undefined` catalog provenance fields.

### Task 5: Propagate Catalog Provenance Through Selection And Runtime State

**Files:**
- Modify: `cli/services/llmArchitectureSelector.js`
- Modify: `cli/services/llmRuntimeIntegration.js`
- Test: `tests/unit/llmArchitectureSelector.test.mjs`
- Test: `tests/unit/llmRuntimeIntegration.test.mjs`

- [ ] **Step 1: Add provenance fields to selection result**

In `cli/services/llmArchitectureSelector.js`, update the object returned by `selectArchitecture(...)`.

After:

```js
catalogRef: catalog.catalogRef,
```

add:

```js
catalogSource: catalog.source || null,
catalogRepoUrl: catalog.repoUrl || null,
catalogRequestedRef: catalog.requestedRef || null,
```

- [ ] **Step 2: Add provenance fields to selected architecture state**

In `cli/services/llmRuntimeIntegration.js`, update the `catalog` block inside `buildSelectedArchitectureState(...)`.

Replace:

```js
catalog: {
    id: selection.catalogId,
    ref: selection.catalogRef,
},
```

with:

```js
catalog: {
    id: selection.catalogId,
    ref: selection.catalogRef,
    source: selection.catalogSource || null,
    repoUrl: selection.catalogRepoUrl || null,
    requestedRef: selection.catalogRequestedRef || null,
},
```

- [ ] **Step 3: Add provenance fields to reuse key**

In `cli/services/llmRuntimeIntegration.js`, update `reuseKey`.

After:

```js
catalogRef: selection.catalogRef,
```

add:

```js
catalogSource: selection.catalogSource || null,
catalogRepoUrl: selection.catalogRepoUrl || null,
catalogRequestedRef: selection.catalogRequestedRef || null,
```

- [ ] **Step 4: Run provenance tests**

Run:

```bash
node --test tests/unit/llmArchitectureSelector.test.mjs tests/unit/llmRuntimeIntegration.test.mjs
```

Expected after implementation: PASS with `fail 0`.

- [ ] **Step 5: Commit provenance propagation**

Run:

```bash
git add cli/services/llmArchitectureSelector.js cli/services/llmRuntimeIntegration.js tests/unit/llmArchitectureSelector.test.mjs tests/unit/llmRuntimeIntegration.test.mjs
git commit -m "Record LLM catalog provenance in runtime state"
```

Expected: one commit on `llm-runtime-containers`.

### Task 6: Add Remote Retrieval Coverage To Startup Integration

**Files:**
- Modify: `tests/unit/llmRuntimeIntegration.test.mjs`
- Test: `tests/unit/llmRuntimeIntegration.test.mjs`

- [ ] **Step 1: Import `execFileSync` and `pathToFileURL`**

At the top of `tests/unit/llmRuntimeIntegration.test.mjs`, add:

```js
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
```

- [ ] **Step 2: Add Git helpers**

After `withTempDirs(fn)`, add:

```js
function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function fileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

function initCatalogGitRepo(catalogRoot) {
    git(['init', '--quiet', '-b', 'main'], catalogRoot);
    git(['config', 'user.email', 'runtime-integration@example.invalid'], catalogRoot);
    git(['config', 'user.name', 'Runtime Integration Tests'], catalogRoot);
    git(['add', '.'], catalogRoot);
    git(['commit', '--quiet', '-m', 'catalog'], catalogRoot);
    return git(['rev-parse', 'HEAD'], catalogRoot);
}
```

- [ ] **Step 3: Add startup test for configured remote repo**

Add this test after `prepareLlmStartup selects catalog architecture and writes state file`:

```js
test('prepareLlmStartup records remote catalog provenance from configured repo', () => {
    withTempDirs(({ agentsRoot, catalogRoot, workspace }) => {
        const commit = initCatalogGitRepo(catalogRoot);
        const cacheDir = path.join(workspace, '.ploinky', 'llm-catalog-cache');
        const repoUrl = fileUrl(catalogRoot);

        const result = prepareLlmStartup({
            runtime: 'docker',
            manifest: { llmRuntime: { enabled: true } },
            profileConfig: null,
            agentName: 'baseLocal',
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            agentWorkDirRoot: agentsRoot,
            envHash: 'envhash-remote',
            effectiveNetwork: null,
        });

        assert.equal(result.selection.catalogSource, 'git');
        assert.equal(result.selection.catalogRepoUrl, repoUrl);
        assert.equal(result.selection.catalogRequestedRef, 'main');
        assert.equal(result.selection.catalogRef, commit);
        assert.equal(result.reuseKey.catalogSource, 'git');
        assert.equal(result.reuseKey.catalogRepoUrl, repoUrl);
        assert.equal(result.reuseKey.catalogRequestedRef, 'main');

        const stateFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'selected-architecture.json');
        const stateJson = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.deepEqual(stateJson.catalog, {
            id: 'test/catalog',
            ref: commit,
            source: 'git',
            repoUrl,
            requestedRef: 'main',
        });
    });
});
```

- [ ] **Step 4: Run integration test**

Run:

```bash
node --test tests/unit/llmRuntimeIntegration.test.mjs
```

Expected: PASS with `fail 0`.

- [ ] **Step 5: Commit remote startup coverage**

Run:

```bash
git add tests/unit/llmRuntimeIntegration.test.mjs
git commit -m "Test remote LLM catalog startup provenance"
```

Expected: one commit on `llm-runtime-containers`.

### Task 7: Update Error Text And Documentation References

**Files:**
- Modify: `cli/services/llmArchitectureCatalog.js`
- Modify: `docs/specs/DS012-local-llm-agent-architecture-catalog.md`
- Modify: `docs/superpowers/specs/2026-07-02-remote-llm-architecture-catalog-design.md`

- [ ] **Step 1: Confirm no code error mentions workspace sibling**

Run:

```bash
rg -n "workspace default path|default workspace|sibling|DEFAULT_CATALOG_PATH|local-llm-architectures catalog found" cli/services/llmArchitectureCatalog.js
```

Expected after Task 2: no matches.

- [ ] **Step 2: Confirm docs match implementation constants**

Run:

```bash
rg -n "https://github.com/AssistOS-AI/local-llm-architectures.git|default ref `main`|default ref is.*main|no implicit sibling" docs/specs/DS012-local-llm-agent-architecture-catalog.md docs/superpowers/specs/2026-07-02-remote-llm-architecture-catalog-design.md
```

Expected: matches in both docs for the default repo and no-implicit-sibling rule.

- [ ] **Step 3: Confirm code constants match docs**

Check that `cli/services/llmArchitectureCatalog.js` contains:

```js
const DEFAULT_CATALOG_REPO_URL = 'https://github.com/AssistOS-AI/local-llm-architectures.git';
const DEFAULT_CATALOG_REF = 'main';
```

Expected: both constants are present exactly as shown. No docs edit is needed when the constants match.

### Task 8: Final Verification

**Files:**
- Test only

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
node --test tests/unit/llmArchitectureCatalog.test.mjs tests/unit/llmArchitectureSelector.test.mjs tests/unit/llmRuntimeIntegration.test.mjs
```

Expected: PASS with `fail 0`.

- [ ] **Step 2: Run the broader focused LLM runtime unit set**

Run:

```bash
node --test tests/unit/containerRuntime.test.mjs tests/unit/containerRuntimePolicy.test.mjs tests/unit/hardwareDetection.test.mjs tests/unit/llmArchitectureCatalog.test.mjs tests/unit/llmArchitectureSelector.test.mjs tests/unit/llmRuntimeIntegration.test.mjs
```

Expected: PASS with `fail 0`.

- [ ] **Step 3: Check branch status and confirm node_modules remains unstaged**

Run:

```bash
git status --short --branch
```

Expected output shape:

```text
## llm-runtime-containers...origin/llm-runtime-containers [ahead N]
 M node_modules/achillesAgentLib
```

If the implementation commits have already been pushed, the branch line will not include `[ahead N]`. The only local dirty item should be `node_modules/achillesAgentLib`.

- [ ] **Step 4: Push implementation commits**

Run:

```bash
git push origin llm-runtime-containers
```

Expected: remote `llm-runtime-containers` updates successfully.

## Self-Review Checklist

| Spec Requirement | Covered By |
| --- | --- |
| Explicit path remains first priority | Task 1 Step 4, Task 2 Step 3 |
| Explicit remote repo/ref is supported | Task 1 Step 5, Task 2 Step 3 |
| Built-in default remote repo/ref is supported | Task 1 Step 6, Task 2 Step 3 |
| Sibling fallback is removed | Task 2 Step 4, Task 3, Task 7 Step 1 |
| Cache key uses repo URL and ref | Task 2 Step 2 |
| Existing cache is used after fetch failure | Task 1 Step 7, Task 2 Step 2 |
| First-run fetch failure is clear | Task 1 Step 8, Task 2 Step 2 |
| Selected state includes provenance | Task 4 Step 2, Task 5 Step 2, Task 6 Step 3 |
| Reuse hash observes provenance | Task 4 Step 2, Task 5 Step 3 |
| Validation boundary remains unchanged | Existing catalog validation tests plus Task 8 |
