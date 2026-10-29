import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    SourceTransitionRefused,
    abortSourceTransition,
    beginSourceTransition,
    initializeSourceProtection,
    withApprovedSourceTransition,
} from '../../cli/utils/runtime/sourceProtectionGate.mjs';

// P5 lifecycle call sites. The workspace root is fixed when `cli/utils/config.js` loads, so this file selects its
// temporary workspace through PLOINKY_WORKSPACE_ROOT before it imports any lifecycle module (and imports no other
// test's helpers). Synthetic data only; no Git command, process or container runs.

test('P5 lifecycle call sites: agent links, alias links and repository commands are gated by the same decision', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ploinky-p5-sites-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
    });
    const { createAgentSymlinks } = await import('../../cli/utils/workspaceStructure.js');
    const repos = await import('../../cli/utils/repos.js');
    const agentA = path.join(root, 'srcA');
    const agentB = path.join(root, 'srcB');
    fs.mkdirSync(path.join(agentA, 'code'), { recursive: true });
    fs.mkdirSync(path.join(agentB, 'code'), { recursive: true });

    // Ordinary workspace: links are created and re-pointed exactly as before; repository commands reach their own checks.
    createAgentSymlinks('worker', 'fixtures', agentA);
    createAgentSymlinks('worker', 'fixtures', agentB);
    assert.equal(fs.readlinkSync(path.join(root, '.ploinky', 'code', 'worker')), path.join(agentB, 'code'));
    assert.deepEqual(repos.disableRepo('absent-repo'), { status: 'not-enabled', name: 'absent-repo' });
    assert.throws(() => repos.updateRegisteredRepository('absent-repo'), (error) => !(error instanceof SourceTransitionRefused));

    const created = await initializeSourceProtection({
        workspaceRoot: root, assertWorkspaceLease: () => {}, enumerateExpectedHolders: async () => ({ status: 'known', principals: ['agent:fixtures/worker'] }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const refused = (fn) => assert.throws(fn, (error) => error instanceof SourceTransitionRefused && error.code === 'source_transition_blocked');
    // Re-creating the identical link is not a source change.
    createAgentSymlinks('worker', 'fixtures', agentB);
    // Re-pointing an agent, a new alias to the same source and the repository commands are source transitions.
    refused(() => createAgentSymlinks('worker', 'fixtures', agentA));
    refused(() => createAgentSymlinks('worker-alias', 'fixtures', agentB));
    refused(() => repos.disableRepo('absent-repo'));
    refused(() => repos.enableRepo('absent-repo'));
    refused(() => repos.installRepo('https://example.invalid/fixtures/new.git'));
    refused(() => repos.updateRegisteredRepository('absent-repo'));
    // The mutating functions themselves are gated, so every caller path is covered (a clone, a branch switch, `ploinky update`).
    const url = 'https://example.invalid/fixtures/other.git';
    refused(() => repos.addRepo('other', url));
    refused(() => repos.ensureRepoInstalled('other', url));
    refused(() => repos.updateWorkspaceRepository(path.join(root, 'srcA')));
    fs.mkdirSync(path.join(root, '.ploinky', 'repos', 'present', '.git'), { recursive: true });
    refused(() => repos.ensureRepoOnBranch('present', { branch: 'feature', resetRepos: true }));
    refused(() => repos.ensureRepoOnBranch('present', { branch: 'feature' }));
    // A no-op request (no branch asked for) changes nothing and is not a transition.
    assert.deepEqual(repos.ensureRepoOnBranch('present', {}), { status: 'noop', branch: null });
    assert.equal(fs.readlinkSync(path.join(root, '.ploinky', 'code', 'worker')), path.join(agentB, 'code'));
    assert.equal(fs.existsSync(path.join(root, '.ploinky', 'code', 'worker-alias')), false);

    // A prepared transition lets the same edit through once, inside its synchronous scope, for its allowed kinds only.
    const begun = await beginSourceTransition({
        workspaceRoot: root, assertWorkspaceLease: () => {}, operationId: 'AAAAAAAAAAAAAAAAAAAAAA', kinds: ['agent-link'],
    });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    withApprovedSourceTransition(begun.value.approval, () => {
        createAgentSymlinks('worker-alias', 'fixtures', agentB);
        assert.throws(() => repos.disableRepo('absent-repo'), (error) => error instanceof SourceTransitionRefused);
    });
    assert.equal(fs.existsSync(path.join(root, '.ploinky', 'code', 'worker-alias')), true);
    refused(() => createAgentSymlinks('worker-other', 'fixtures', agentB));
    assert.equal((await abortSourceTransition({ workspaceRoot: root, assertWorkspaceLease: () => {} })).ok, true);
    refused(() => createAgentSymlinks('worker-other', 'fixtures', agentB));
});

test('P5 the link-creation catch sites rethrow a refused source transition and keep every other error as a warning', () => {
    const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
    const agents = read('cli/utils/agents.js');
    assert.match(agents, /if \(error\?\.code === 'source_transition_blocked'\) throw error;\n\s+console\.error\(`Warning: Failed to create workspace structure/);
    const hooks = read('cli/utils/runtime/lifecycleHooks.js');
    assert.equal(hooks.match(/if \(err\?\.code === 'source_transition_blocked'\) throw err;/g).length, 2);
});
