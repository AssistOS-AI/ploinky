import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    INTERACTIVE_PLOINKY_UPDATE_MESSAGE,
    PLOINKY_BOX_MARKER_PATH,
    parseGitDependencyRef,
    resolveMovingGitDepCommits,
    updatePloinkySelf,
} from '../../cli/commands/updateService.js';

function tempDir(prefix = 'ploinky-update-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 4));
}

test('interactive Ploinky self-update is deferred when upstream has a new version', () => {
    const root = tempDir();
    const warnings = [];

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });

        const result = updatePloinkySelf({
            repoPath: root,
            interactiveSession: true,
            logger: { warn(message) { warnings.push(message); } },
            checkUpdate() {
                return {
                    available: true,
                    head: 'old-head',
                    upstream: 'new-head',
                };
            },
            pull() {
                throw new Error('interactive update must not pull');
            },
        });

        assert.equal(result.deferred, true);
        assert.equal(result.updateAvailable, true);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0], INTERACTIVE_PLOINKY_UPDATE_MESSAGE);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('non-interactive Ploinky self-update pulls and reports changed HEAD', () => {
    const root = tempDir();
    let pulled = false;

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });

        const result = updatePloinkySelf({
            repoPath: root,
            getRef() {
                return pulled ? 'new-head' : 'old-head';
            },
            pull(repoPath) {
                assert.equal(repoPath, root);
                pulled = true;
            },
        });

        assert.equal(pulled, true);
        assert.equal(result.updated, true);
        assert.equal(result.before, 'old-head');
        assert.equal(result.after, 'new-head');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box self-update skips the read-only source before running git operations', () => {
    const root = tempDir();
    const warnings = [];
    const unexpected = () => {
        throw new Error('boxed self-update must not inspect or mutate the source checkout');
    };

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });

        const result = updatePloinkySelf({
            repoPath: root,
            interactiveSession: true,
            exists(filePath) {
                assert.equal(filePath, PLOINKY_BOX_MARKER_PATH);
                return true;
            },
            logger: { warn(message) { warnings.push(message); } },
            checkUpdate: unexpected,
            pull: unexpected,
            getRef: unexpected,
        });

        assert.deepEqual(result, {
            skipped: true,
            boxed: true,
            reason: 'Ploinky source is mounted read-only inside ploinky-box',
            repoPath: root,
        });
        assert.deepEqual(warnings, [
            `Skipping Ploinky self-update inside ploinky-box: ${root} is mounted read-only.`,
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('parseGitDependencyRef extracts url + ref for moving git specs and strips git+', () => {
    assert.deepEqual(
        parseGitDependencyRef('git+https://github.com/AssistOS-AI/achillesAgentLib.git#master'),
        { url: 'https://github.com/AssistOS-AI/achillesAgentLib.git', ref: 'master' },
    );
    assert.deepEqual(
        parseGitDependencyRef('git+https://github.com/AssistOS-AI/MCPSDK.git#main'),
        { url: 'https://github.com/AssistOS-AI/MCPSDK.git', ref: 'main' },
    );
    assert.deepEqual(
        parseGitDependencyRef('git+ssh://git@github.com/o/r.git#dev'),
        { url: 'ssh://git@github.com/o/r.git', ref: 'dev' },
    );
});

test('parseGitDependencyRef treats a git url with no #ref as the moving default branch', () => {
    assert.deepEqual(
        parseGitDependencyRef('git+https://github.com/o/r.git'),
        { url: 'https://github.com/o/r.git', ref: 'HEAD' },
    );
});

test('parseGitDependencyRef returns null for non-git and pinned-commit specs', () => {
    assert.equal(parseGitDependencyRef('^1.0.0'), null);
    assert.equal(parseGitDependencyRef('1.2.3'), null);
    assert.equal(parseGitDependencyRef(''), null);
    assert.equal(parseGitDependencyRef(undefined), null);
    // A 40-hex pinned commit cannot move, so it is not a "moving" ref.
    assert.equal(
        parseGitDependencyRef('git+https://github.com/o/r.git#0123456789abcdef0123456789abcdef01234567'),
        null,
    );
});

test('resolveMovingGitDepCommits resolves each moving git dep via ls-remote, skipping others', () => {
    const calls = [];
    const commits = resolveMovingGitDepCommits(
        {
            achillesAgentLib: 'git+https://github.com/AssistOS-AI/achillesAgentLib.git#master',
            'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        },
        {
            execFile(command, args) {
                calls.push({ command, args });
                const url = args[args.length - 2];
                const ref = args[args.length - 1];
                const sha = url.includes('MCPSDK')
                    ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
                    : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
                return `${sha}\trefs/heads/${ref}\n`;
            },
        },
    );

    assert.deepEqual(commits, {
        achillesAgentLib: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'mcp-sdk': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    // Only the two moving git dependencies are ls-remote'd.
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.command === 'git' && c.args[0] === 'ls-remote'));
});

test('resolveMovingGitDepCommits omits deps whose ls-remote fails (fail-open)', () => {
    const commits = resolveMovingGitDepCommits(
        {
            achillesAgentLib: 'git+https://github.com/AssistOS-AI/achillesAgentLib.git#master',
            'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        },
        {
            execFile(command, args) {
                if (args[args.length - 2].includes('MCPSDK')) {
                    throw new Error('offline');
                }
                return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/master\n';
            },
        },
    );

    assert.deepEqual(commits, { achillesAgentLib: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
});

test('resolveMovingGitDepCommits omits deps with empty/non-sha ls-remote output', () => {
    const commits = resolveMovingGitDepCommits(
        { achillesAgentLib: 'git+https://github.com/AssistOS-AI/achillesAgentLib.git#nope' },
        { execFile() { return '\n'; } },
    );
    assert.deepEqual(commits, {});
});

