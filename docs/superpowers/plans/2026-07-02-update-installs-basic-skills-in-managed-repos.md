# Install AchillesCopilotBasicSkills During Managed Repo Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `ploinky update` managed-repo flow refresh `AchillesCopilotBasicSkills` into installed repositories under `.ploinky/repos/`.

**Architecture:** Reuse the existing `installDefaultSkills()` service so skill copying, `.agents/skills`, `.claude` compatibility links, legacy migration, and managed `.gitignore` blocks stay consistent with the `default-skills` command. Add a small managed-repo helper in `repoAgentCommands.js`, call it after managed repo pulls in `update`, `update repos`, and `update repo <name>`, and treat failures as update failures. Skip installing the skills into the `AchillesCopilotBasicSkills` source checkout itself to avoid self-mutating the catalog repo.

**Tech Stack:** Node.js ESM, built-in `fs`, `path`, and `node:test`. Existing services: `cli/services/skills.js`, `cli/services/repos.js`, `cli/commands/repoAgentCommands.js`.

---

## Approaches Considered

**Recommended: reuse `installDefaultSkills()` for each managed repo.**
This keeps one implementation for skill copy semantics and preserves the existing `.claude` and `.gitignore` behavior. The new code only decides which managed repos receive the default skills.

**Alternative: add a manifest automatically to each managed repo.**
This would reuse `installSkillsFromManifest()`, but it would write new manifest files into third-party repo checkouts and change the meaning of manifests. More moving parts, less clear ownership.

**Alternative: copy `AchillesCopilotBasicSkills/skills` directly in `update`.**
This is smaller at first, but duplicates `default-skills` behavior and risks drift in `.agents`, `.claude`, legacy migration, and `.gitignore` handling.

## File Structure

| File | Change |
| --- | --- |
| `cli/commands/repoAgentCommands.js` | Add a helper that installs `AchillesCopilotBasicSkills` into managed repo targets and wire it into all update variants. |
| `tests/unit/skillsRefresh.test.mjs` | Add unit coverage for managed-repo default skill refresh, source-repo skipping, and failure reporting. |
| `README.md` | Update command summary for the new managed-repo skill refresh behavior. |
| `cli/services/help.js` | Update `update` help text. |
| `docs/ploinky-overview.md` | Update operator-facing command semantics. |
| `docs/operations.html` | Update operations docs. |
| `docs/cli-reference.html` | Update CLI reference. |
| `docs/specs/DS002-workspace-and-repository-model.md` | Update the repository model contract. |
| `docs/specs/DS008-secrets-skills-and-llm-assistance.md` | Update the skill refresh contract and rationale. |

---

## Task 1: Add Managed-Repo Default-Skills Unit Tests

**Files:**
- Modify: `tests/unit/skillsRefresh.test.mjs`

- [ ] **Step 1: Add imports**

In `tests/unit/skillsRefresh.test.mjs`, extend the imports:

```js
import { execFileSync } from 'child_process';
import {
    refreshDefaultSkillsInPloinkyRepos,
} from '../../cli/commands/repoAgentCommands.js';
```

- [ ] **Step 2: Add test helpers**

Append these helpers after the existing `createRepo()` helper:

```js
function initGitRepo(repoPath) {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
}

function removeRepo(repoName) {
    fs.rmSync(path.join(REPOS_DIR, repoName), { recursive: true, force: true });
}
```

- [ ] **Step 3: Add the positive behavior test**

Append this test to `tests/unit/skillsRefresh.test.mjs`:

```js
test('refreshDefaultSkillsInPloinkyRepos installs AchillesCopilotBasicSkills into managed repos', () => {
    const sourceRepo = 'AchillesCopilotBasicSkills';
    const managedRepo = `UnitManagedRepo-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);

    removeRepo(sourceRepo);
    removeRepo(managedRepo);
    createRepo(sourceRepo, {
        defaultSkill: {
            'SKILL.md': '# Default skill\n',
            'tool.js': 'export default 1;\n',
        },
    });
    initGitRepo(managedPath);

    try {
        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo, sourceRepo]);

        assert.equal(result.defaultSkillsRepoName, sourceRepo);
        assert.equal(result.refreshed.length, 1);
        assert.equal(result.refreshed[0].repoName, managedRepo);
        assert.equal(result.skipped.length, 1);
        assert.equal(result.skipped[0].repoName, sourceRepo);
        assert.equal(result.failed.length, 0);
        assert.equal(
            fs.existsSync(path.join(managedPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
            true,
        );
        assert.equal(fs.lstatSync(path.join(managedPath, '.claude')).isSymbolicLink(), true);

        const gitignore = fs.readFileSync(path.join(managedPath, '.gitignore'), 'utf8');
        assert.match(gitignore, /^\.claude$/m);
        assert.match(gitignore, /^\.agents\/skills\/defaultSkill\/$/m);
        assert.doesNotMatch(gitignore, /^\.agents$/m);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});
```

- [ ] **Step 4: Add the failure reporting test**

Append this test:

```js
test('refreshDefaultSkillsInPloinkyRepos reports default skill install failures', () => {
    const sourceRepo = 'AchillesCopilotBasicSkills';
    const managedRepo = `UnitManagedRepoFailure-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    removeRepo(sourceRepo);
    removeRepo(managedRepo);
    fs.mkdirSync(sourcePath, { recursive: true });
    initGitRepo(managedPath);

    try {
        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo]);

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].repoName, managedRepo);
        assert.match(result.failed[0].message, /No skills\/ folder in repo 'AchillesCopilotBasicSkills'/);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});
```

- [ ] **Step 5: Run the tests and confirm they fail**

Run:

```bash
node --test tests/unit/skillsRefresh.test.mjs
```

Expected: failure because `refreshDefaultSkillsInPloinkyRepos` is not exported yet.

---

## Task 2: Add the Managed-Repo Default-Skills Helper

**Files:**
- Modify: `cli/commands/repoAgentCommands.js`

- [ ] **Step 1: Add constants near `REPOS_DIR`**

Add below `const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');`:

```js
const DEFAULT_SKILLS_REPO_NAME = 'AchillesCopilotBasicSkills';
```

- [ ] **Step 2: Add the refresh helper after `getGitRepoNames()`**

Add:

```js
function refreshDefaultSkillsInPloinkyRepo(repoName, {
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAME,
} = {}) {
    const normalizedRepoName = String(repoName || '').trim();
    if (!normalizedRepoName) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'missing repo name' };
    }
    if (normalizedRepoName === defaultSkillsRepoName) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'default skills source repo' };
    }

    const repoPath = path.join(REPOS_DIR, normalizedRepoName);
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        return { repoName: normalizedRepoName, skipped: true, reason: 'repo path missing' };
    }

    const result = skillsSvc.installDefaultSkills(defaultSkillsRepoName, {
        targetRoot: repoPath,
    });

    return {
        repoName: normalizedRepoName,
        repoPath,
        skills: result.skills,
        gitignoreUpdated: result.gitignoreUpdated,
        claudeLink: result.claudeLink,
        refreshed: true,
    };
}

function refreshDefaultSkillsInPloinkyRepos(repoNames = getGitRepoNames(), {
    defaultSkillsRepoName = DEFAULT_SKILLS_REPO_NAME,
} = {}) {
    const refreshed = [];
    const skipped = [];
    const failed = [];

    for (const repoName of repoNames) {
        try {
            const result = refreshDefaultSkillsInPloinkyRepo(repoName, { defaultSkillsRepoName });
            if (result.refreshed) {
                refreshed.push(result);
            } else {
                skipped.push(result);
            }
        } catch (err) {
            failed.push({
                repoName,
                message: err?.message || String(err),
            });
        }
    }

    return {
        defaultSkillsRepoName,
        total: repoNames.length,
        refreshed,
        skipped,
        failed,
    };
}
```

- [ ] **Step 3: Export the helper**

In the export block at the bottom of `repoAgentCommands.js`, add:

```js
    refreshDefaultSkillsInPloinkyRepos,
```

- [ ] **Step 4: Run the new tests**

Run:

```bash
node --test tests/unit/skillsRefresh.test.mjs
```

Expected: PASS for the new helper tests and existing skill refresh tests.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/repoAgentCommands.js tests/unit/skillsRefresh.test.mjs
git commit -m "Add managed repo default skill refresh helper"
```

---

## Task 3: Wire the Helper Into All Update Flows

**Files:**
- Modify: `cli/commands/repoAgentCommands.js`

- [ ] **Step 1: Add a small failure appender after `formatWorkspaceRepoSkip()`**

Add:

```js
function appendDefaultSkillFailures(failed, summary) {
    for (const entry of summary.failed) {
        failed.push({
            repoName: `${entry.repoName} default skills`,
            message: entry.message,
        });
    }
}

function logDefaultSkillSummary(summary, indent = '') {
    if (!summary.total) return;
    const eligible = summary.total - summary.skipped.length;
    console.log(`${indent}Default skills summary: ${summary.refreshed.length}/${eligible} managed repo(s) refreshed from ${summary.defaultSkillsRepoName}.`);
    for (const entry of summary.skipped) {
        console.log(`${indent}  - ${entry.repoName}: skipped default skills (${entry.reason})`);
    }
    for (const entry of summary.failed) {
        console.error(`${indent}  ✗ ${entry.repoName}: ${entry.message}`);
    }
}
```

- [ ] **Step 2: Update `updateRepo(repoName)`**

After the Achilles dependency refresh block in `updateRepo`, add:

```js
        const defaultSkills = refreshDefaultSkillsInPloinkyRepos([repoName]);
        logDefaultSkillSummary(defaultSkills, '  ');
        if (defaultSkills.failed.length) {
            const failedPackages = defaultSkills.failed.map(entry => entry.repoName).join(', ');
            throw new Error(`Failed to refresh default skills in ${failedPackages}`);
        }
```

Expected placement: after `refreshAchillesDependenciesInRepos({ reposRoot: repoPath })` failure handling, before the `catch`.

- [ ] **Step 3: Update `updatePloinkyRepos()`**

After Achilles dependency failure handling and before the summary lines, add:

```js
    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos);
    logDefaultSkillSummary(defaultSkills);
    appendDefaultSkillFailures(failed, defaultSkills);
```

Update the returned object to include `defaultSkills`:

```js
    return { total: ploinkyRepos.length, updated, failed, runtimeAchilles, achilles, defaultSkills };
```

- [ ] **Step 4: Update `updateAllRepos(folderPath, options)`**

After Achilles dependency failure handling and before manifest-folder installation, add:

```js
    const defaultSkills = refreshDefaultSkillsInPloinkyRepos(ploinkyRepos);
    logDefaultSkillSummary(defaultSkills);
    appendDefaultSkillFailures(failed, defaultSkills);
```

Update the returned object to include `defaultSkills`:

```js
    return { total: totalRepos, updated, failed, skipped, selfUpdate, runtimeAchilles, achilles, defaultSkills };
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
node --test tests/unit/skillsRefresh.test.mjs tests/unit/repoDiscovery.test.mjs tests/unit/updateService.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/commands/repoAgentCommands.js
git commit -m "Refresh default skills during managed repo updates"
```

---

## Task 4: Add Update-Flow Coverage for Command Return Shapes

**Files:**
- Modify: `tests/unit/skillsRefresh.test.mjs`

- [ ] **Step 1: Add an assertion that helper results expose enough metadata**

In the positive helper test from Task 1, after `assert.equal(result.refreshed.length, 1);`, add:

```js
        assert.deepEqual(result.refreshed[0].skills, ['defaultSkill']);
        assert.equal(result.refreshed[0].gitignoreUpdated, true);
        assert.equal(result.refreshed[0].claudeLink.mode, 'root');
```

- [ ] **Step 2: Re-run the targeted test**

Run:

```bash
node --test tests/unit/skillsRefresh.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/skillsRefresh.test.mjs
git commit -m "Cover managed repo default skill refresh metadata"
```

---

## Task 5: Update CLI Help and Docs

**Files:**
- Modify: `README.md`
- Modify: `cli/services/help.js`
- Modify: `docs/ploinky-overview.md`
- Modify: `docs/operations.html`
- Modify: `docs/cli-reference.html`
- Modify: `docs/specs/DS002-workspace-and-repository-model.md`
- Modify: `docs/specs/DS008-secrets-skills-and-llm-assistance.md`

- [ ] **Step 1: Update `README.md`**

Change the update bullet from:

```md
- `update [folderPath]`: update the Ploinky checkout, refresh `node_modules/achillesAgentLib`, update managed repos, and refresh discovered project repositories and default skills.
```

to:

```md
- `update [folderPath]`: update the Ploinky checkout, refresh `node_modules/achillesAgentLib`, update managed repos, refresh `AchillesCopilotBasicSkills` into installed `.ploinky/repos/` checkouts, and refresh discovered project repositories and manifest-selected skills.
```

- [ ] **Step 2: Update `cli/services/help.js`**

In the `update` command notes, replace the sentence beginning with `` `update` is the same full workflow`` so it includes:

```js
"`update` is the same full workflow as `update all`: it runs git pull --rebase --autostash for the Ploinky checkout, refreshes ploinky/node_modules/achillesAgentLib, updates .ploinky/repos, refreshes AchillesCopilotBasicSkills into each eligible installed .ploinky/repos checkout, and updates git repositories discovered recursively from folderPath. Without folderPath, discovery starts at the current working directory. Missing or unreachable remotes in discovered project repositories are logged and skipped instead of failing the full update; managed .ploinky/repos updates and managed-repo default-skill refreshes remain strict. `update repos` updates installed .ploinky/repos, the Ploinky runtime achillesAgentLib checkout, managed-repo achillesAgentLib packages, and managed-repo default skills. Discovered workspace folders can define `ploinky-skills-manifest.json`; when present, that file must be an array of objects with url/name/branch/skills and selects the exact skills to install into `.agents/skills` for that workspace folder. In an interactive Ploinky session, a detected Ploinky self-update is deferred: close the session, run `ploinky update`, then restart Ploinky so the new code is loaded."
```

- [ ] **Step 3: Update Markdown docs**

In `docs/ploinky-overview.md`, update the `update`, `update repos`, and `update repo <name>` bullets to state that the managed repo default skill refresh runs for eligible installed `.ploinky/repos` targets and skips the `AchillesCopilotBasicSkills` source checkout.

In `docs/specs/DS002-workspace-and-repository-model.md`, update the update-flow paragraph so it says managed repo updates include a post-pull default-skill refresh into eligible installed repos under `.ploinky/repos/`.

In `docs/specs/DS008-secrets-skills-and-llm-assistance.md`, add that managed repo update flows use `AchillesCopilotBasicSkills` as the default catalog and reuse `default-skills` merge behavior, while manifest-based workspace folders still reconstruct `.agents/skills` strictly from manifest selection.

- [ ] **Step 4: Update HTML docs**

In `docs/operations.html`, update the operations paragraph about `default-skills` and `update` to include the managed repo default-skill refresh.

In `docs/cli-reference.html`, update the `update` command description to include managed repo default-skill refresh and the skip of the source checkout.

- [ ] **Step 5: Verify docs mention the new behavior consistently**

Run:

```bash
rg -n "AchillesCopilotBasicSkills|managed-repo default|default skill" README.md cli/services/help.js docs/ploinky-overview.md docs/operations.html docs/cli-reference.html docs/specs/DS002-workspace-and-repository-model.md docs/specs/DS008-secrets-skills-and-llm-assistance.md
```

Expected: each updated surface mentions the new behavior or still has a relevant default-skills reference.

- [ ] **Step 6: Commit**

```bash
git add README.md cli/services/help.js docs/ploinky-overview.md docs/operations.html docs/cli-reference.html docs/specs/DS002-workspace-and-repository-model.md docs/specs/DS008-secrets-skills-and-llm-assistance.md
git commit -m "Document managed repo default skill refresh during update"
```

---

## Task 6: Final Verification

**Files:**
- No file edits unless verification finds a defect.

- [ ] **Step 1: Run targeted unit tests**

```bash
node --test tests/unit/skillsRefresh.test.mjs tests/unit/repoDiscovery.test.mjs tests/unit/updateService.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the full unit suite if time permits**

```bash
node --test tests/unit/*.test.mjs
```

Expected: PASS. If failures appear outside the touched update/skills surfaces, inspect before deciding whether they are pre-existing.

- [ ] **Step 3: Do a manual dry inspection of the command path**

Run:

```bash
rg -n "refreshDefaultSkillsInPloinkyRepos|logDefaultSkillSummary|appendDefaultSkillFailures" cli/commands/repoAgentCommands.js
```

Expected:
- helper definition exists
- helper is exported
- `updateRepo`, `updatePloinkyRepos`, and `updateAllRepos` all call it

- [ ] **Step 4: Check git status**

```bash
git status --short
```

Expected: only files from this plan are modified, unless the working tree already had unrelated changes.

---

## Self-Review

Spec coverage:
- The plan targets the existing `AchillesCopilotBasicSkills` predefined repo.
- The plan covers `.agents/skills` and `.claude` creation by reusing `installDefaultSkills()`.
- The plan covers installed `.ploinky/repos` checkouts via all managed update surfaces.
- The plan avoids changing manifest-based discovered workspace behavior.

Placeholder scan:
- No placeholder markers.
- Each task names exact files and commands.

Type consistency:
- The new helper is named `refreshDefaultSkillsInPloinkyRepos` everywhere.
- Result fields are consistent: `defaultSkillsRepoName`, `total`, `refreshed`, `skipped`, `failed`.
