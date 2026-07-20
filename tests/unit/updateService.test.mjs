import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    INTERACTIVE_PLOINKY_UPDATE_MESSAGE,
    PLOINKY_BOX_MARKER_PATH,
    findAchillesDependencyPackages,
    parseGitDependencyRef,
    refreshAchillesDependenciesInRepos,
    refreshPloinkyRuntimeAchillesDependency,
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

test('findAchillesDependencyPackages finds packages in repos and ignores node_modules', () => {
    const root = tempDir();

    try {
        writeJson(path.join(root, 'repoA', 'agentA', 'package.json'), {
            dependencies: {
                achillesAgentLib: 'git+https://example.invalid/achillesAgentLib.git',
            },
        });
        writeJson(path.join(root, 'repoA', 'agentA', 'node_modules', 'nested', 'package.json'), {
            dependencies: {
                achillesAgentLib: 'should-be-ignored',
            },
        });
        writeJson(path.join(root, 'repoB', 'agentB', 'package.json'), {
            dependencies: {
                leftpad: '1.0.0',
            },
        });
        writeJson(path.join(root, 'repoC', 'package.json'), {
            devDependencies: {
                achillesAgentLib: 'git+https://example.invalid/achillesAgentLib.git',
            },
        });

        const found = findAchillesDependencyPackages(root)
            .map(entry => path.relative(root, entry.packageDir))
            .sort();

        assert.deepEqual(found, ['repoA/agentA', 'repoC']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('refreshAchillesDependenciesInRepos updates installed git dependency or falls back to npm update', () => {
    const root = tempDir();
    const calls = [];

    try {
        const gitBacked = path.join(root, 'repoA', 'agentA');
        const npmBacked = path.join(root, 'repoB', 'agentB');
        writeJson(path.join(gitBacked, 'package.json'), {
            dependencies: { achillesAgentLib: 'git+https://example.invalid/achillesAgentLib.git' },
        });
        writeJson(path.join(npmBacked, 'package.json'), {
            dependencies: { achillesAgentLib: 'git+https://example.invalid/achillesAgentLib.git' },
        });
        fs.mkdirSync(path.join(gitBacked, 'node_modules', 'achillesAgentLib', '.git'), { recursive: true });

        const result = refreshAchillesDependenciesInRepos({
            reposRoot: root,
            logger: { log() {}, error() {} },
            stdio: 'ignore',
            spawn(command, args, options) {
                calls.push({ command, args, cwd: options.cwd });
                return { status: 0 };
            },
        });

        assert.equal(result.total, 2);
        assert.equal(result.refreshed.length, 2);
        assert.equal(result.failed.length, 0);
        assert.deepEqual(calls.map(call => call.command).sort(), ['git', 'npm']);
        assert.ok(calls.some(call => call.command === 'git'
            && call.args.includes('pull')
            && call.cwd.endsWith(path.join('node_modules', 'achillesAgentLib'))));
        assert.ok(calls.some(call => call.command === 'npm'
            && call.args.join(' ') === 'update achillesAgentLib --no-package-lock'
            && call.cwd === npmBacked));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('refreshPloinkyRuntimeAchillesDependency pulls the canonical runtime checkout', () => {
    const root = tempDir();
    const calls = [];

    try {
        const installedPath = path.join(root, 'node_modules', 'achillesAgentLib');
        fs.mkdirSync(path.join(installedPath, '.git'), { recursive: true });

        const result = refreshPloinkyRuntimeAchillesDependency({
            ploinkyRoot: root,
            stdio: 'ignore',
            spawn(command, args, options) {
                calls.push({ command, args, cwd: options.cwd });
                return { status: 0 };
            },
        });

        assert.equal(result.method, 'git-pull');
        assert.equal(result.installedPath, installedPath);
        assert.deepEqual(calls, [{
            command: 'git',
            args: ['pull', '--rebase', '--autostash'],
            cwd: installedPath,
        }]);
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

test('refreshPloinkyRuntimeAchillesDependency reclones the canonical runtime checkout when missing', () => {
    const root = tempDir();
    const sourceUrl = 'https://example.invalid/achillesAgentLib.git';
    const calls = [];

    try {
        const installedPath = path.join(root, 'node_modules', 'achillesAgentLib');

        const result = refreshPloinkyRuntimeAchillesDependency({
            ploinkyRoot: root,
            sourceUrl,
            stdio: 'ignore',
            spawn(command, args, options) {
                calls.push({ command, args, cwd: options.cwd });
                if (command === 'git' && args[0] === 'clone') {
                    fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
                }
                return { status: 0 };
            },
        });

        assert.equal(result.method, 'git-clone');
        assert.equal(result.installedPath, installedPath);
        assert.equal(fs.existsSync(path.join(installedPath, '.git')), true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, 'git');
        assert.deepEqual(calls[0].args.slice(0, 3), ['clone', '--quiet', sourceUrl]);
        assert.equal(calls[0].cwd, path.join(root, 'node_modules'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
