import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { PLOINKY_DIR, REPOS_DIR } from '../../cli/utils/config.js';
import {
    refreshDefaultSkillsInPloinkyRepos,
} from '../../cli/commands/repoAgentCommands.js';
import { copySkill, installDefaultSkills } from '../../cli/commands/skills.js';

function writeSkill(root, name, files) {
    const skillRoot = path.join(root, name);
    fs.mkdirSync(skillRoot, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
        const filePath = path.join(skillRoot, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function createRepo(repoName, skills) {
    const repoRoot = path.join(REPOS_DIR, repoName);
    const skillsRoot = path.join(repoRoot, 'skills');
    fs.rmSync(repoRoot, { recursive: true, force: true });
    for (const [name, files] of Object.entries(skills)) {
        writeSkill(skillsRoot, name, files);
    }
    return repoRoot;
}

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

function projectFileUrl(relPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return pathToFileURL(path.join(projectRoot, relPath)).href;
}

function runAggregateUpdateChild(workspaceRoot, body) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const configUrl = projectFileUrl('cli/utils/config.js');
    const commandsUrl = projectFileUrl('cli/commands/repoAgentCommands.js');
    const agentLibFixtureUrl = projectFileUrl('tests/helpers/agentlibFixture.mjs');
    const agentLibContractUrl = projectFileUrl('agentlib/contract.mjs');
    const boxConstantsUrl = projectFileUrl('ploinky-box/constants.mjs');
    const runtimeRoot = path.join(workspaceRoot, '.fixtures', 'runtime-root');

    execFileSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { execFileSync } from 'node:child_process';

        const workspaceRoot = ${JSON.stringify(workspaceRoot)};
        const runtimeRoot = ${JSON.stringify(runtimeRoot)};
        process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
        process.env.PLOINKY_ROOT = runtimeRoot;

        function mkdir(dir) {
            fs.mkdirSync(dir, { recursive: true });
        }

        function writeFile(filePath, content) {
            mkdir(path.dirname(filePath));
            fs.writeFileSync(filePath, content);
        }

        function initGitRepo(repoPath, files = { 'README.md': '# repo\\n' }) {
            mkdir(repoPath);
            execFileSync('git', ['init', '-q'], { cwd: repoPath, stdio: 'ignore' });
            execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'ignore' });
            execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
            for (const [relPath, content] of Object.entries(files)) {
                writeFile(path.join(repoPath, relPath), content);
            }
            execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
        }

        function cloneRepo(sourcePath, destinationPath) {
            mkdir(path.dirname(destinationPath));
            execFileSync('git', ['clone', '--quiet', sourcePath, destinationPath], { stdio: 'ignore' });
        }

        function commitFile(repoPath, relativePath, content) {
            writeFile(path.join(repoPath, relativePath), content);
            execFileSync('git', ['add', relativePath], { cwd: repoPath, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'advance fixture'], { cwd: repoPath, stdio: 'ignore' });
            return String(execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: repoPath, encoding: 'utf8',
            })).trim();
        }

        function readHead(repoPath) {
            return String(execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: repoPath, encoding: 'utf8',
            })).trim();
        }

        async function captureUpdate(operation) {
            const stdout = [];
            const stderr = [];
            const original = { log: console.log, error: console.error, warn: console.warn };
            console.log = (...values) => stdout.push(values.map(String).join(' '));
            console.error = console.warn = (...values) => stderr.push(values.map(String).join(' '));
            try {
                return { result: await operation(), stdout, stderr };
            } finally {
                Object.assign(console, original);
            }
        }

        function assertFinalFailureDetails(stderr, failures) {
            const summaryIndex = stderr.lastIndexOf(
                'Update completed with ' + failures.length + ' error(s):',
            );
            assert.notEqual(summaryIndex, -1, 'a nonfatal final error summary is logged');
            const summary = stderr.slice(summaryIndex + 1).join('\\n');
            for (const failure of failures) {
                assert.ok(summary.includes(failure.repoName), 'summary identifies ' + failure.repoName);
                assert.ok(summary.includes(failure.message), 'summary retains the underlying error');
            }
        }

        function shellQuotePath(filePath) {
            return '"' + filePath.replace(/["\\\\$]/g, '\\\\$&') + '"';
        }

        function installGitWrapper() {
            const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
            const binDir = path.join(workspaceRoot, '.fixtures', 'bin');
            mkdir(binDir);
            const wrapperPath = path.join(binDir, 'git');
            fs.writeFileSync(wrapperPath, [
                '#!/bin/sh',
                'if [ -n "$PLOINKY_TEST_GIT_TRACE" ]; then',
                '  printf "%s\\\\n" "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
                'fi',
                'is_ls_remote=0',
                'for arg in "$@"; do',
                '  if [ "$arg" = "ls-remote" ]; then',
                '    is_ls_remote=1',
                '  fi',
                'done',
                'if [ "$is_ls_remote" = "1" ]; then',
                '  case " $* " in',
                '    *github.com/AssistOS-AI/achillesAgentLib.git*|*github.com/AssistOS-AI/MCPSDK.git*)',
                '      echo "0123456789abcdef0123456789abcdef01234567\\trefs/heads/main"',
                '      exit 0',
                '      ;;',
                '  esac',
                '  for arg in "$@"; do',
                '    case "$arg" in',
                '      http://*|https://*|ssh://*|git@*)',
                '        echo "unexpected external git ls-remote in aggregate update test: $arg" >&2',
                '        exit 99',
                '        ;;',
                '    esac',
                '  done',
                'fi',
                'exec ' + shellQuotePath(realGit) + ' "$@"',
                '',
            ].join('\\n'));
            fs.chmodSync(wrapperPath, 0o755);
            process.env.PATH = binDir + path.delimiter + process.env.PATH;
        }

        function setupRuntimeAchilles() {
            const sourcePath = path.join(workspaceRoot, '.fixtures', 'achilles-source');
            const installedPath = path.join(runtimeRoot, 'node_modules', 'achillesAgentLib');
            initGitRepo(sourcePath, { 'README.md': '# achilles\\n' });
            mkdir(path.dirname(installedPath));
            execFileSync('git', ['clone', '--quiet', sourcePath, installedPath], { stdio: 'ignore' });
        }

        function setupAggregateRepoFixture({ defaultSkillsHasSkills = true } = {}) {
            const unique = process.pid + '-' + Date.now();
            const repoName = 'UnitAggregateRepo-' + unique;
            const providerName = 'UnitAggregateProvider-' + unique;
            const sourceRepoPath = path.join(workspaceRoot, '.fixtures', 'source-repo');
            const installedRepoPath = path.join(REPOS_DIR, repoName);
            const defaultSkillsRepoPath = path.join(REPOS_DIR, 'AchillesCopilotBasicSkills');
            const defaultSkillsSources = [
                {
                    name: 'AchillesCopilotBasicSkills',
                    sourcePath: path.join(workspaceRoot, '.fixtures', 'default-skills-source'),
                    files: defaultSkillsHasSkills
                        ? { 'skills/defaultSkill/SKILL.md': '# Default skill\\n' }
                        : { 'README.md': '# default skills\\n' },
                },
                {
                    name: 'DocumentationSkills',
                    sourcePath: path.join(workspaceRoot, '.fixtures', 'documentation-skills-source'),
                    files: { 'skills/documentationSkill/SKILL.md': '# Documentation skill\\n' },
                },
                {
                    name: 'PloinkySkills',
                    sourcePath: path.join(workspaceRoot, '.fixtures', 'ploinky-skills-source'),
                    files: { 'skills/ploinkySkill/SKILL.md': '# Ploinky skill\\n' },
                },
            ];

            mkdir(REPOS_DIR);
            initGitRepo(sourceRepoPath, { 'README.md': '# managed\\n' });
            for (const source of defaultSkillsSources) {
                initGitRepo(source.sourcePath, source.files);
            }
            mkdir(path.join(REPOS_DIR, providerName, 'agent'));
            writeFile(path.join(REPOS_DIR, providerName, 'agent', 'manifest.json'), JSON.stringify({
                repos: { [repoName]: sourceRepoPath },
            }, null, 2));
            mkdir(installedRepoPath);
            writeFile(path.join(installedRepoPath, 'stale.txt'), 'stale\\n');
            for (const source of defaultSkillsSources) {
                execFileSync('git', ['clone', '--quiet', source.sourcePath, path.join(REPOS_DIR, source.name)], {
                    stdio: 'ignore',
                });
            }

            return { repoName, installedRepoPath, sourceRepoPath, defaultSkillsRepoPath };
        }

        function assertDefaultSkillsSummary(summary, repoName) {
            assert.ok(summary, 'aggregate result includes defaultSkills');
            assert.equal(summary.defaultSkillsRepoName, null);
            assert.deepEqual(summary.defaultSkillsRepoNames, [
                'AchillesCopilotBasicSkills',
                'DocumentationSkills',
                'PloinkySkills',
            ]);
            assert.equal(summary.total, 12);
            assert.equal(summary.refreshed.length, 3);
            assert.deepEqual([...new Set(summary.refreshed.map(entry => entry.repoName))], [repoName]);
            assert.equal(summary.skipped.length, 9);
            assert.equal(summary.skipped.filter(entry => entry.reason === 'default skills source repo').length, 3);
            assert.equal(summary.skipped.filter(entry => entry.reason === 'skills-only repo').length, 6);
            assert.equal(summary.failed.length, 0);
        }

        installGitWrapper();
        setupRuntimeAchilles();

        const { REPOS_DIR } = await import(${JSON.stringify(configUrl)});
        const { updatePloinkyRepos, updateAllRepos } = await import(${JSON.stringify(commandsUrl)});
        const { writeAgentLibCheckout } = await import(${JSON.stringify(agentLibFixtureUrl)});
        const { AGENTLIB_ENV, AGENTLIB_LOCAL_DIR_NAME } = await import(${JSON.stringify(agentLibContractUrl)});
        const { BOX_MARKER_PATH } = await import(${JSON.stringify(boxConstantsUrl)});

        ${body}
    `], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: runtimeRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

test('copySkill replaces destination so removed source files do not linger', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-'));
    try {
        const src = path.join(root, 'src-skill');
        const dest = path.join(root, 'dest-skill');

        fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, 'SKILL.md'), '# Current skill\n');
        fs.writeFileSync(path.join(src, 'tool.js'), 'export default 1;\n');
        fs.chmodSync(path.join(src, 'tool.js'), 0o755);
        fs.mkdirSync(path.join(src, 'assets'));
        fs.writeFileSync(path.join(src, 'assets', 'prompt.txt'), 'nested asset\n');
        fs.symlinkSync('SKILL.md', path.join(src, 'README.md'));

        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'stale.js'), 'stale file\n');

        copySkill(src, dest);

        // Files from source are copied / overwritten
        assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(dest, 'tool.js')), true);
        assert.equal(fs.readFileSync(path.join(dest, 'assets', 'prompt.txt'), 'utf8'), 'nested asset\n');
        assert.equal(fs.statSync(path.join(dest, 'tool.js')).mode & 0o777, 0o755);
        assert.equal(fs.lstatSync(path.join(dest, 'README.md')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(dest, 'README.md')), 'SKILL.md');
        // Files only in this owned destination skill are removed
        assert.equal(fs.existsSync(path.join(dest, 'stale.js')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('installDefaultSkills refreshes incoming skills and preserves other .agents skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-install-'));
    const repoName = `UnitSkills-${process.pid}-${Date.now()}-agents`;
    const repoRoot = createRepo(repoName, {
        owned: {
            'SKILL.md': '# Current skill\n',
            'tool.js': 'export default 1;\n',
        },
    });

    try {
        writeSkill(path.join(root, '.agents', 'skills'), 'owned', {
            'SKILL.md': '# Old skill\n',
            'stale.js': 'stale file\n',
        });
        writeSkill(path.join(root, '.agents', 'skills'), 'local-only', {
            'SKILL.md': '# Local skill\n',
        });
        fs.writeFileSync(path.join(root, '.gitignore'), [
            '# >>> ploinky default-skills >>>',
            '.claude/skills/',
            '.agents/skills/',
            '# <<< ploinky default-skills <<<',
            '',
        ].join('\n'));

        installDefaultSkills(repoName, { targetRoot: root });

        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'tool.js')), true);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'stale.js')), false);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'local-only', 'SKILL.md')), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(root, '.claude')), '.agents');

        const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
        assert.match(gitignore, /^\.claude$/m);
        assert.match(gitignore, /^\.agents\/skills\/owned\/$/m);
        assert.doesNotMatch(gitignore, /^\.agents\/skills\/$/m);
        assert.doesNotMatch(gitignore, /local-only/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('refreshDefaultSkillsInPloinkyRepos installs default skills into managed repos', () => {
    const sourceRepo = `UnitDefaultSkillsRepo-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepo-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
                'tool.js': 'export default 1;\n',
            },
        });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo, sourceRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

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
        assert.equal(fs.readlinkSync(path.join(managedPath, '.claude')), '.agents');
        assert.equal(fs.existsSync(path.join(sourcePath, '.agents')), false);

        const gitignore = fs.readFileSync(path.join(managedPath, '.gitignore'), 'utf8');
        assert.match(gitignore, /^\.claude$/m);
        assert.match(gitignore, /^\.agents\/skills\/defaultSkill\/$/m);
        assert.doesNotMatch(gitignore, /^\.agents$/m);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});

test('refreshDefaultSkillsInPloinkyRepos skips skills-only repos', () => {
    const sourceRepo = `UnitDefaultSkillsSourceRepo-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepoWithSkillsSkip-${process.pid}-${Date.now()}`;
    const skillsRepo = `UnitSkillsOnlyRepo-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const skillsPath = path.join(REPOS_DIR, skillsRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        removeRepo(skillsRepo);
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
            },
        });
        createRepo(skillsRepo, {
            catalogSkill: {
                'SKILL.md': '# Catalog skill\n',
            },
        });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo, skillsRepo, sourceRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 1);
        assert.equal(result.refreshed[0].repoName, managedRepo);
        assert.equal(result.skipped.length, 2);
        assert.deepEqual(
            result.skipped.map(entry => ({ repoName: entry.repoName, reason: entry.reason })),
            [
                { repoName: skillsRepo, reason: 'skills-only repo' },
                { repoName: sourceRepo, reason: 'default skills source repo' },
            ],
        );
        assert.equal(result.failed.length, 0);
        assert.equal(
            fs.existsSync(path.join(managedPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
            true,
        );
        assert.equal(fs.existsSync(path.join(skillsPath, '.agents')), false);
        assert.equal(fs.existsSync(path.join(sourcePath, '.agents')), false);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        removeRepo(skillsRepo);
    }
});

test('refreshDefaultSkillsInPloinkyRepos rejects path-like repo names', () => {
    const sourceRepo = `UnitDefaultSkillsSafeSource-${process.pid}-${Date.now()}`;
    const outsideName = `UnitDefaultSkillsOutside-${process.pid}-${Date.now()}`;
    const pathLikeRepo = `../${outsideName}`;
    const outsidePath = path.join(REPOS_DIR, '..', outsideName);

    try {
        removeRepo(sourceRepo);
        fs.rmSync(outsidePath, { recursive: true, force: true });
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
            },
        });
        fs.mkdirSync(outsidePath, { recursive: true });

        const result = refreshDefaultSkillsInPloinkyRepos([pathLikeRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.skipped.length, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].repoName, pathLikeRepo);
        assert.match(result.failed[0].message, /Invalid repository name/);
        assert.equal(fs.existsSync(path.join(outsidePath, '.agents')), false);
        assert.equal(fs.existsSync(path.join(outsidePath, '.claude')), false);
    } finally {
        removeRepo(sourceRepo);
        fs.rmSync(outsidePath, { recursive: true, force: true });
    }
});

test('refreshDefaultSkillsInPloinkyRepos rejects dot repo names without root pollution', () => {
    const sourceRepo = `UnitDefaultSkillsDotSource-${process.pid}-${Date.now()}`;
    const skillName = `defaultSkillDot-${process.pid}-${Date.now()}`;
    const pollutionPaths = [
        path.join(REPOS_DIR, '.agents'),
        path.join(REPOS_DIR, '.claude'),
        path.join(PLOINKY_DIR, '.agents'),
        path.join(PLOINKY_DIR, '.claude'),
    ];
    const existedBefore = new Map(pollutionPaths.map(targetPath => [targetPath, fs.existsSync(targetPath)]));

    try {
        removeRepo(sourceRepo);
        createRepo(sourceRepo, {
            [skillName]: {
                'SKILL.md': '# Default skill\n',
            },
        });

        const result = refreshDefaultSkillsInPloinkyRepos(['.', '..'], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.skipped.length, 0);
        assert.equal(result.failed.length, 2);
        assert.deepEqual(result.failed.map(entry => entry.repoName), ['.', '..']);
        assert.match(result.failed[0].message, /Invalid repository name/);
        assert.match(result.failed[1].message, /Invalid repository name/);
        for (const targetPath of pollutionPaths) {
            if (!existedBefore.get(targetPath)) {
                assert.equal(fs.existsSync(targetPath), false);
            }
        }
        assert.equal(fs.existsSync(path.join(REPOS_DIR, '.agents', 'skills', skillName)), false);
        assert.equal(fs.existsSync(path.join(PLOINKY_DIR, '.agents', 'skills', skillName)), false);
    } finally {
        removeRepo(sourceRepo);
        for (const root of [REPOS_DIR, PLOINKY_DIR]) {
            fs.rmSync(path.join(root, '.agents', 'skills', skillName), { recursive: true, force: true });
            fs.rmSync(path.join(root, '.claude', 'skills', skillName), { recursive: true, force: true });
        }
        for (const targetPath of pollutionPaths) {
            if (!existedBefore.get(targetPath)) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            }
        }
    }
});

test('refreshDefaultSkillsInPloinkyRepos reports default skill install failures', () => {
    const sourceRepo = `UnitDefaultSkillsRepoFailure-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepoFailure-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        fs.mkdirSync(sourcePath, { recursive: true });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([` ${managedRepo} `], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].repoName, managedRepo);
        assert.match(result.failed[0].message, new RegExp(`No skills/ folder in repo '${sourceRepo}'`));
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});

test('updateRepo reports default skill refresh failures after updating a managed repo', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-default-skills-'));
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const configUrl = projectFileUrl('cli/utils/config.js');
    const commandsUrl = projectFileUrl('cli/commands/repoAgentCommands.js');

    try {
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { execFileSync } from 'node:child_process';

            const workspaceRoot = ${JSON.stringify(workspaceRoot)};
            process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;

            const { REPOS_DIR } = await import(${JSON.stringify(configUrl)});
            const { updateRepo } = await import(${JSON.stringify(commandsUrl)});

            function mkdir(dir) {
                fs.mkdirSync(dir, { recursive: true });
            }

            function initGitRepo(repoPath) {
                mkdir(repoPath);
                execFileSync('git', ['init', '-q'], { cwd: repoPath, stdio: 'ignore' });
                execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'ignore' });
                execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
                fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\\n');
                execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
                execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
            }

            const repoName = 'UnitCommandRepo-${process.pid}-${Date.now()}';
            const providerName = 'UnitCommandProvider-${process.pid}-${Date.now()}';
            const sourceRepoPath = path.join(workspaceRoot, 'source-repo');
            const installedRepoPath = path.join(REPOS_DIR, repoName);
            const defaultSkillsRepoPaths = [
                path.join(REPOS_DIR, 'AchillesCopilotBasicSkills'),
                path.join(REPOS_DIR, 'DocumentationSkills'),
                path.join(REPOS_DIR, 'PloinkySkills'),
            ];

            mkdir(REPOS_DIR);
            initGitRepo(sourceRepoPath);
            mkdir(path.join(REPOS_DIR, providerName, 'agent'));
            fs.writeFileSync(path.join(REPOS_DIR, providerName, 'agent', 'manifest.json'), JSON.stringify({
                repos: { [repoName]: sourceRepoPath },
            }, null, 2));
            mkdir(installedRepoPath);
            fs.writeFileSync(path.join(installedRepoPath, 'stale.txt'), 'stale\\n');
            for (const [index, defaultSkillsRepoPath] of defaultSkillsRepoPaths.entries()) {
                mkdir(defaultSkillsRepoPath);
                if (index > 0) {
                    const skillName = 'source-' + index;
                    mkdir(path.join(defaultSkillsRepoPath, 'skills', skillName));
                    fs.writeFileSync(
                        path.join(defaultSkillsRepoPath, 'skills', skillName, 'SKILL.md'),
                        '# Source ' + index + '\\n',
                    );
                }
            }

            const logs = [];
            const originalLog = console.log;
            console.log = (message = '') => {
                logs.push(String(message));
            };
            try {
                await assert.rejects(
                    () => updateRepo(repoName),
                    (err) => {
                        assert.match(
                            err.message,
                            new RegExp('update repo failed: Failed to refresh default skills in ' + repoName),
                        );
                        return true;
                    },
                );
            } finally {
                console.log = originalLog;
            }

            assert.equal(fs.existsSync(path.join(installedRepoPath, 'README.md')), true);
            assert.equal(fs.existsSync(path.join(installedRepoPath, 'stale.txt')), false);
            assert.ok(logs.includes('  Default skills summary: 2/3 repo(s) refreshed.'));
        `], {
            cwd: projectRoot,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('aggregate update commands return default skill summaries after refreshing managed repos', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-aggregate-default-skills-'));

    try {
        runAggregateUpdateChild(workspaceRoot, `
            const fixture = setupAggregateRepoFixture();
            const installedSkillPath = path.join(
                fixture.installedRepoPath,
                '.agents',
                'skills',
                'defaultSkill',
                'SKILL.md',
            );

            const ploinkyResult = await updatePloinkyRepos({ interactiveSession: true });

            assert.equal(ploinkyResult.failed.length, 0);
            assertDefaultSkillsSummary(ploinkyResult.defaultSkills, fixture.repoName);
            assert.equal(fs.existsSync(path.join(fixture.installedRepoPath, 'README.md')), true);
            assert.equal(fs.existsSync(path.join(fixture.installedRepoPath, 'stale.txt')), false);
            assert.equal(fs.existsSync(installedSkillPath), true);

            fs.rmSync(path.join(fixture.installedRepoPath, '.agents'), { recursive: true, force: true });
            fs.rmSync(path.join(fixture.installedRepoPath, '.claude'), { recursive: true, force: true });
            assert.equal(fs.existsSync(installedSkillPath), false);

            const allResult = await updateAllRepos(workspaceRoot, { interactiveSession: true });

            assert.equal(allResult.failed.length, 0);
            assertDefaultSkillsSummary(allResult.defaultSkills, fixture.repoName);
            assert.equal(fs.existsSync(installedSkillPath), true);
            assert.equal(fs.lstatSync(path.join(fixture.installedRepoPath, '.claude')).isSymbolicLink(), true);
        `);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

for (const command of ['updatePloinkyRepos', 'updateAllRepos']) {
    const invocation = command === 'updatePloinkyRepos'
        ? 'updatePloinkyRepos({ interactiveSession: true })'
        : 'updateAllRepos(workspaceRoot, { interactiveSession: true })';

    test(command + ' logs default skill failures and continues refreshing other sources', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-aggregate-default-skills-failure-'));

        try {
            runAggregateUpdateChild(workspaceRoot, String.raw`
                const fixture = setupAggregateRepoFixture({ defaultSkillsHasSkills: false });
                const { result, stderr } = await captureUpdate(() => ${invocation});

                assert.equal(result.failed.length, 1);
                assert.equal(result.failed[0].repoName, 'default skills ' + fixture.repoName);
                assert.match(result.failed[0].message, /No skills\/ folder in repo 'AchillesCopilotBasicSkills'/);
                assert.equal(result.defaultSkills.failed.length, 1);
                assert.equal(result.defaultSkills.refreshed.filter(entry => entry.repoName === fixture.repoName).length, 2);
                assertFinalFailureDetails(stderr, result.failed);
                assert.equal(fs.existsSync(path.join(fixture.installedRepoPath, 'README.md')), true);
                assert.equal(
                    fs.existsSync(path.join(fixture.installedRepoPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
                    false,
                );
                for (const skillName of ['documentationSkill', 'ploinkySkill']) {
                    assert.equal(fs.existsSync(path.join(
                        fixture.installedRepoPath, '.agents', 'skills', skillName, 'SKILL.md',
                    )), true, 'later default source installed ' + skillName);
                }
            `);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    test(command + ' continues after a managed repository pull fails', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-managed-update-continue-'));

        try {
            runAggregateUpdateChild(workspaceRoot, String.raw`
                const fixture = setupAggregateRepoFixture();
                const failedRepoName = 'AAFailedManaged';
                const laterRepoName = 'ZZLaterManaged';
                const failedRepoPath = path.join(REPOS_DIR, failedRepoName);
                const laterRepoPath = path.join(REPOS_DIR, laterRepoName);
                cloneRepo(fixture.sourceRepoPath, failedRepoPath);
                cloneRepo(fixture.sourceRepoPath, laterRepoPath);
                execFileSync('git', ['checkout', '--detach', '--quiet'], {
                    cwd: failedRepoPath, stdio: 'ignore',
                });
                const oldHead = readHead(laterRepoPath);
                const newHead = commitFile(fixture.sourceRepoPath, 'upstream.txt', 'updated upstream');
                assert.notEqual(newHead, oldHead);

                const { result, stdout, stderr } = await captureUpdate(() => ${invocation});

                assert.equal(result.failed.length, 1);
                assert.equal(result.failed[0].repoName, failedRepoName);
                assert.match(result.failed[0].message, /git .*pull .*exited with status [1-9]/);
                assert.match(result.failed[0].message, /not currently on a branch/);
                assert.equal(readHead(failedRepoPath), oldHead);
                assert.equal(readHead(laterRepoPath), newHead, 'a later managed checkout advances');
                assert.ok(stdout.includes('  ✓ ' + laterRepoName));
                assertFinalFailureDetails(stderr, result.failed);
            `);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
}

test('updateAllRepos continues after a workspace pull fails and retains its error details', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-update-continue-'));

    try {
        runAggregateUpdateChild(workspaceRoot, String.raw`
            const fixture = setupAggregateRepoFixture();
            const failedRepoName = 'aa-workspace-failure';
            const failedRepoPath = path.join(workspaceRoot, failedRepoName);
            const laterRepoPath = path.join(workspaceRoot, 'zz-workspace-success');
            cloneRepo(fixture.sourceRepoPath, failedRepoPath);
            cloneRepo(fixture.sourceRepoPath, laterRepoPath);
            execFileSync('git', ['checkout', '--detach', '--quiet'], {
                cwd: failedRepoPath, stdio: 'ignore',
            });
            const oldHead = readHead(laterRepoPath);
            const newHead = commitFile(fixture.sourceRepoPath, 'upstream.txt', 'updated upstream');

            const { result, stdout, stderr } = await captureUpdate(() => (
                updateAllRepos(workspaceRoot, { interactiveSession: true })
            ));

            assert.equal(result.failed.length, 1);
            assert.equal(result.failed[0].repoName, failedRepoName);
            assert.match(result.failed[0].message, /git .*pull .*exited with status [1-9]/);
            assert.match(result.failed[0].message, /not currently on a branch/);
            assert.equal(result.skipped.length, 0, 'the failing remote is reachable and the pull was attempted');
            assert.equal(readHead(failedRepoPath), oldHead);
            assert.equal(readHead(laterRepoPath), newHead, 'a later workspace checkout advances');
            assert.ok(stdout.includes('  ✓ zz-workspace-success'));
            assertFinalFailureDetails(stderr, result.failed);
        `);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('updateAllRepos installs later skills manifests after an earlier manifest fails', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-update-continue-'));

    try {
        runAggregateUpdateChild(workspaceRoot, String.raw`
            setupAggregateRepoFixture();
            const badManifestPath = path.join(workspaceRoot, 'aa-invalid', 'ploinky-skills-manifest.json');
            const validFolder = path.join(workspaceRoot, 'zz-valid');
            writeFile(badManifestPath, JSON.stringify([{
                name: 'DocumentationSkills',
                url: path.join(workspaceRoot, '.fixtures', 'documentation-skills-source'),
                skills: ['removedSkill'],
            }]));
            writeFile(path.join(validFolder, 'ploinky-skills-manifest.json'), JSON.stringify([{
                name: 'DocumentationSkills',
                url: path.join(workspaceRoot, '.fixtures', 'documentation-skills-source'),
                skills: ['documentationSkill'],
            }]));

            const { result, stdout, stderr } = await captureUpdate(() => (
                updateAllRepos(workspaceRoot, { interactiveSession: true })
            ));

            assert.equal(result.failed.length, 1);
            assert.equal(result.failed[0].repoName, 'aa-invalid skills');
            assert.match(result.failed[0].message, /Skill 'removedSkill' was not found/);
            assert.match(result.failed[0].message, /source repo 'DocumentationSkills'/);
            assert.match(result.failed[0].message, /Available skills: documentationSkill/);
            assert.equal(fs.readFileSync(path.join(
                validFolder, '.agents', 'skills', 'documentationSkill', 'SKILL.md',
            ), 'utf8'), '# Documentation skill\n');
            assert.ok(stdout.some(message => message.includes('✓ zz-valid: 1 skill(s)')));
            assertFinalFailureDetails(stderr, result.failed);
            const finalSummary = stderr.slice(stderr.lastIndexOf('Update completed with 1 error(s):')).join('\n');
            assert.ok(finalSummary.includes(badManifestPath), 'the final error identifies the failing manifest');
        `);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

for (const wrongUpstream of ['origin/main', 'secondary/feature']) {
    test('updateAllRepos prevents skill cache contamination from ' + wrongUpstream, () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-upstream-continue-'));
        try {
            runAggregateUpdateChild(workspaceRoot, String.raw`
                setupAggregateRepoFixture();
                const source = path.join(workspaceRoot, '.fixtures', 'branch-source');
                initGitRepo(source, { 'skills/shared/SKILL.md': '# main\n' });
                const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
                git(source, 'branch', '-M', 'main');
                git(source, 'checkout', '-b', 'feature');
                commitFile(source, 'skills/shared/SKILL.md', '# feature\n');
                const cache = path.join(REPOS_DIR, 'SelectedSkills');
                cloneRepo(source, cache);
                const selectedHead = readHead(cache);
                const wrongUpstream = ${JSON.stringify(wrongUpstream)};
                if (wrongUpstream === 'secondary/feature') {
                    const secondary = path.join(workspaceRoot, '.fixtures', 'secondary');
                    cloneRepo(source, secondary);
                    git(secondary, 'config', 'user.name', 'Test User');
                    git(secondary, 'config', 'user.email', 'test@example.invalid');
                    commitFile(secondary, 'skills/foreign/SKILL.md', '# wrong source\n');
                    git(cache, 'remote', 'add', 'secondary', secondary);
                    git(cache, 'fetch', 'secondary');
                } else {
                    git(source, 'checkout', 'main');
                    commitFile(source, 'skills/foreign/SKILL.md', '# wrong branch\n');
                }
                git(cache, 'branch', '--set-upstream-to=' + wrongUpstream, 'feature');
                const folder = path.join(workspaceRoot, 'valid-selected-skills');
                writeFile(path.join(folder, 'ploinky-skills-manifest.json'), JSON.stringify([{
                    name: 'SelectedSkills', url: source, branch: 'feature', skills: ['shared'],
                }]));
                const { result, stderr } = await captureUpdate(() => updateAllRepos(workspaceRoot, { interactiveSession: true }));
                assert.equal(result.failed.length, 1);
                assert.equal(result.failed[0].repoName, 'SelectedSkills');
                assert.match(result.failed[0].message, /Refusing to pull a different source or branch/);
                assert.equal(readHead(cache), selectedHead);
                assert.equal(fs.existsSync(path.join(cache, 'skills', 'foreign')), false);
                assert.equal(fs.readFileSync(path.join(folder, '.agents', 'skills', 'shared', 'SKILL.md'), 'utf8'), '# feature\n');
                assertFinalFailureDetails(stderr, result.failed);
            `);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
}

test('updateAllRepos still rejects an invalid selected search root', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-invalid-root-'));

    try {
        runAggregateUpdateChild(workspaceRoot, String.raw`
            const nonDirectory = path.join(workspaceRoot, 'a-file');
            writeFile(nonDirectory, 'not a directory');
            for (const invalidRoot of [path.join(workspaceRoot, 'missing'), nonDirectory]) {
                await assert.rejects(
                    () => updateAllRepos(invalidRoot, { interactiveSession: true }),
                    /Search root .* is not a directory/,
                );
            }
        `);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

for (const runtimeAlreadySelected of [true, false]) {
    test('updateAllRepos preserves the host local AgentLib source '
        + (runtimeAlreadySelected ? 'already selected by the runtime' : 'newly selected during refresh'), () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-agentlib-host-'));

        try {
            runAggregateUpdateChild(workspaceRoot, String.raw`
                setupAggregateRepoFixture();
                const sourcePath = path.join(workspaceRoot, '.fixtures', 'agentlib-upstream');
                initGitRepo(sourcePath);
                writeAgentLibCheckout(sourcePath);
                execFileSync('git', ['add', '.'], { cwd: sourcePath, stdio: 'ignore' });
                execFileSync('git', ['commit', '-m', 'add runtime entrypoints'], { cwd: sourcePath, stdio: 'ignore' });
                const selectedPath = path.join(workspaceRoot, AGENTLIB_LOCAL_DIR_NAME);
                const unrelatedPath = path.join(workspaceRoot, 'project', AGENTLIB_LOCAL_DIR_NAME);
                cloneRepo(sourcePath, selectedPath);
                cloneRepo(sourcePath, unrelatedPath);
                const originalHead = readHead(selectedPath);
                const upstreamHead = commitFile(sourcePath, 'upstream.txt', 'new upstream content');
                if (${runtimeAlreadySelected}) process.env[AGENTLIB_ENV.dir] = selectedPath;
                const tracePath = path.join(workspaceRoot, '.fixtures', 'git-activity.log');
                process.env.PLOINKY_TEST_GIT_TRACE = tracePath;

                const { result } = await captureUpdate(() => updateAllRepos(workspaceRoot));

                const activity = fs.readFileSync(tracePath, 'utf8').split('\n');
                assert.equal(result.failed.length, 0);
                assert.equal(result.agentLib.mode, 'local');
                assert.equal(result.agentLib.selection.sourceDir, fs.realpathSync(selectedPath));
                assert.equal(readHead(selectedPath), originalHead, 'developer-owned checkout must not advance');
                assert.equal(fs.existsSync(path.join(selectedPath, 'upstream.txt')), false);
                assert.equal(readHead(unrelatedPath), upstreamHead, 'a distinct repository with the same name still updates');
                const selectedActivity = activity.filter(line => [selectedPath, fs.realpathSync(selectedPath)]
                    .some(location => line.startsWith('-C ' + location + ' ')));
                assert.ok(selectedActivity.every(line => !/ (?:pull|fetch|ls-remote|reset|checkout)(?: |$)/.test(line)),
                    'selected source permits read-only revision reporting, never a generic Git update: ' + selectedActivity.join('\n'));
            `);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
}

for (const runtimeAlias of ['direct path', 'symlink alias', 'bind alias']) {
    test('updateAllRepos excludes the in-Box selected AgentLib source through a ' + runtimeAlias, () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-agentlib-box-'));

        try {
            runAggregateUpdateChild(workspaceRoot, String.raw`
                const fixture = setupAggregateRepoFixture();
                const selectedPath = path.join(workspaceRoot, AGENTLIB_LOCAL_DIR_NAME);
                const unrelatedPath = path.join(workspaceRoot, 'project', AGENTLIB_LOCAL_DIR_NAME);
                cloneRepo(fixture.sourceRepoPath, selectedPath);
                cloneRepo(fixture.sourceRepoPath, unrelatedPath);
                const originalHead = readHead(selectedPath);
                const upstreamHead = commitFile(fixture.sourceRepoPath, 'upstream.txt', 'new upstream content');
                const aliasKind = ${JSON.stringify(runtimeAlias)};
                let runtimePath = selectedPath;
                if (aliasKind !== 'direct path') {
                    runtimePath = path.join(workspaceRoot, '.fixtures', 'mounted-runtime');
                    if (aliasKind === 'symlink alias') fs.symlinkSync(selectedPath, runtimePath, 'dir');
                    else mkdir(runtimePath);
                }
                process.env[AGENTLIB_ENV.dir] = runtimePath;
                const canonicalRuntimePath = fs.realpathSync(runtimePath);
                const originalStat = fs.statSync;
                fs.statSync = (target, options) => {
                    if (target === BOX_MARKER_PATH) return { isFile: () => true };
                    // Distinct bind mounts preserve physical directory identity even when realpath differs.
                    if (aliasKind === 'bind alias' && path.resolve(target) === canonicalRuntimePath) {
                        return originalStat(selectedPath, options);
                    }
                    const result = originalStat(target, options);
                    if (aliasKind === 'bind alias' && path.resolve(target) === path.resolve(unrelatedPath)) {
                        const selectedStat = originalStat(selectedPath, options);
                        return Object.assign(Object.create(result), {
                            ino: selectedStat.ino,
                            dev: selectedStat.dev + (typeof selectedStat.dev === 'bigint' ? 1n : 1),
                        });
                    }
                    return result;
                };
                const tracePath = path.join(workspaceRoot, '.fixtures', 'git-activity.log');
                process.env.PLOINKY_TEST_GIT_TRACE = tracePath;
                let result;
                try {
                    ({ result } = await captureUpdate(() => updateAllRepos(workspaceRoot, { interactiveSession: true })));
                } finally {
                    fs.statSync = originalStat;
                }

                const activity = fs.readFileSync(tracePath, 'utf8').split('\n');
                assert.equal(result.failed.length, 0);
                assert.equal(result.agentLib, null, 'the in-Box updater leaves source ownership to the host');
                assert.equal(readHead(selectedPath), originalHead, 'the mounted checkout must not be pulled through its workspace path');
                assert.equal(fs.existsSync(path.join(selectedPath, 'upstream.txt')), false);
                assert.equal(readHead(unrelatedPath), upstreamHead, 'same name or inode on another device does not identify the selected source');
                assert.equal(activity.some(line => [selectedPath, fs.realpathSync(selectedPath)]
                    .some(location => line.startsWith('-C ' + location + ' '))), false,
                    'the in-Box selected source must not even receive a remote probe');
            `);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
}

test('installDefaultSkills migrates legacy .claude skills without deleting other .claude content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-claude-'));
    const repoName = `UnitSkills-${process.pid}-${Date.now()}-claude`;
    const repoRoot = createRepo(repoName, {
        owned: {
            'SKILL.md': '# Current skill\n',
            'fresh.js': 'export default 2;\n',
        },
    });

    try {
        writeSkill(path.join(root, '.claude', 'skills'), 'owned', {
            'SKILL.md': '# Old skill\n',
            'stale.js': 'stale file\n',
        });
        writeSkill(path.join(root, '.claude', 'skills'), 'legacy-only', {
            'SKILL.md': '# Legacy skill\n',
        });
        fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'worktrees', 'keep.txt'), 'keep\n');

        installDefaultSkills(repoName, { targetRoot: root });

        assert.equal(fs.existsSync(path.join(root, '.claude', 'worktrees', 'keep.txt')), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude')).isDirectory(), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude', 'skills')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(root, '.claude', 'skills')), '../.agents/skills');

        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'fresh.js')), true);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'stale.js')), false);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'legacy-only', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'legacy-only', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'owned', 'fresh.js')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
