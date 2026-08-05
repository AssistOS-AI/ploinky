import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const suffix = `?t=${Date.now()}`;
const depInstallerUrl = new URL('../../cli/utils/dependencies/dependencyInstaller.js', import.meta.url);
const { resolveAgentlibBranchRef, withScopedAgentlibRef } = await import(`${depInstallerUrl.href}${suffix}`);

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

test('resolveAgentlibBranchRef: an explicit immutable deploy ref takes precedence without a remote branch probe', () => {
    assert.equal(
        resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'fail' },
            {
                env: { PLOINKY_AGENTLIB_REF: DEFAULT_SHA },
                lsRemote() { assert.fail('an explicit immutable ref must not probe a moving branch'); },
                url: 'u',
            },
        ),
        DEFAULT_SHA,
    );
    assert.throws(
        () => resolveAgentlibBranchRef(
            { branch: 'feat', fallback: 'fail' },
            {
                env: { PLOINKY_AGENTLIB_REF: 'main' },
                lsRemote() { assert.fail('an invalid explicit ref must fail before a remote probe'); },
                url: 'u',
            },
        ),
        /immutable 40-hex commit/,
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

test('withScopedAgentlibRef restores deploy ref state after each asynchronous start', async () => {
    const env = {};
    assert.equal(await withScopedAgentlibRef(SHA, async () => {
        assert.equal(env.PLOINKY_AGENTLIB_REF, SHA);
        await Promise.resolve();
        return 'started';
    }, { env }), 'started');
    assert.equal(Object.hasOwn(env, 'PLOINKY_AGENTLIB_REF'), false);

    env.PLOINKY_AGENTLIB_REF = DEFAULT_SHA;
    await assert.rejects(
        withScopedAgentlibRef(SHA, async () => {
            assert.equal(env.PLOINKY_AGENTLIB_REF, SHA);
            throw new Error('start failed');
        }, { env }),
        /start failed/,
    );
    assert.equal(env.PLOINKY_AGENTLIB_REF, DEFAULT_SHA);

    const pinnedSpec = `git+https://github.com/Assistos/achillesAgentLib.git#${SHA}`;
    await withScopedAgentlibRef(pinnedSpec, async () => {
        assert.equal(env.PLOINKY_AGENTLIB_REF, pinnedSpec);
    }, { env });
    assert.equal(env.PLOINKY_AGENTLIB_REF, DEFAULT_SHA);
});

test('withScopedAgentlibRef fails closed instead of racing overlapping process environments', async () => {
    const env = {};
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const first = withScopedAgentlibRef(SHA, async () => blocked, { env });
    await assert.rejects(
        withScopedAgentlibRef(DEFAULT_SHA, async () => {}, { env }),
        /already active/,
    );
    assert.equal(env.PLOINKY_AGENTLIB_REF, SHA);
    release();
    await first;
    assert.equal(Object.hasOwn(env, 'PLOINKY_AGENTLIB_REF'), false);
});

test('start scopes the immutable AgentLib ref around the awaited workspace launch', () => {
    const source = fs.readFileSync(new URL('../../cli/commands/cli.js', import.meta.url), 'utf8');
    const startCase = source.slice(source.indexOf("case 'start':"), source.indexOf("case 'webchat':"));
    assert.match(startCase, /await withScopedAgentlibRef\(agentlibRef,\s*\(\) => startWorkspace\(/);
    assert.doesNotMatch(startCase, /process\.env\.PLOINKY_AGENTLIB_REF\s*=/);
});
