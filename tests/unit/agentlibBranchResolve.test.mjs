import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const suffix = `?t=${Date.now()}`;
const depInstallerUrl = new URL('../../cli/utils/dependencies/dependencyInstaller.js', import.meta.url);
const { resolveAgentlibBranchRef } = await import(`${depInstallerUrl.href}${suffix}`);

const SHA = 'a'.repeat(40);
const DEFAULT_SHA = 'b'.repeat(40);

function lsRemote(stdout, status = 0) {
    return (command, args) => {
        assert.equal(command, 'git');
        assert.deepEqual(args, ['ls-remote', '--exit-code', '--heads', 'u', 'refs/heads/feat']);
        return { status, stdout, stderr: '' };
    };
}

test('resolveAgentlibBranchRef: exact requested branch resolves to its immutable commit', () => {
    assert.equal(
        resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'default' },
            { lsRemote: lsRemote(`${SHA}\trefs/heads/feat\n`), url: 'u' },
        ),
        SHA,
    );
});

test('resolveAgentlibBranchRef: missing branch rejects remote default with default fallback', () => {
    assert.throws(
        () => resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'default' },
            {
                lsRemote: lsRemote(
                    `${DEFAULT_SHA}\tHEAD\n${DEFAULT_SHA}\trefs/heads/main\n`,
                ),
                url: 'u',
            },
        ),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: branch absent with fail fallback throws', () => {
    assert.throws(
        () => resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'fail' },
            { lsRemote: lsRemote('', 2), url: 'u' },
        ),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: mismatched requested ref fails closed', () => {
    assert.throws(
        () => resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'default' },
            { lsRemote: lsRemote(`${SHA}\trefs/heads/feature-other\n`), url: 'u' },
        ),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: non-SHA object id fails closed', () => {
    assert.throws(
        () => resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'default' },
            { lsRemote: lsRemote(`feat\trefs/heads/feat\n`), url: 'u' },
        ),
        /refusing AgentLib dependency fallback/,
    );
});

test('resolveAgentlibBranchRef: no branch returns null', () => {
    assert.equal(resolveAgentlibBranchRef({ branch: null, fallback: 'default' }, {
        lsRemote() {
            assert.fail('no branch must not probe the remote');
        },
        url: 'u',
    }), null);
});
