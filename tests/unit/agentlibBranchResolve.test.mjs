import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const suffix = `?t=${Date.now()}`;
const depInstallerUrl = new URL('../../cli/utils/dependencies/dependencyInstaller.js', import.meta.url);
const { resolveAgentlibBranchRef } = await import(`${depInstallerUrl.href}${suffix}`);

const yes = () => true;   // stub: branch exists on the achillesAgentLib remote
const no = () => false;   // stub: branch absent

// resolveAgentlibBranchRef — use the branch if the remote has it and reject a
// missing branch without silently substituting the pinned dependency spec.
test('resolveAgentlibBranchRef: branch present on remote returns the branch', () => {
    assert.equal(resolveAgentlibBranchRef({ branch: 'feat', fallback: 'default' }, { branchExists: yes, url: 'u' }), 'feat');
});

test('resolveAgentlibBranchRef: branch absent with default fallback throws', () => {
    assert.throws(
        () => resolveAgentlibBranchRef({ branch: 'feat', fallback: 'default' }, { branchExists: no, url: 'u' }),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: branch absent with fail fallback throws', () => {
    assert.throws(
        () => resolveAgentlibBranchRef({ branch: 'feat', fallback: 'fail' }, { branchExists: no, url: 'u' }),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: no branch returns null', () => {
    assert.equal(resolveAgentlibBranchRef({ branch: null, fallback: 'default' }, { branchExists: yes, url: 'u' }), null);
});
