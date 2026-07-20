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
        delete process.env.PLOINKY_AGENTLIB_REF;

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
            const defaultSkillsSourcePath = path.join(workspaceRoot, '.fixtures', 'default-skills-source');
            const installedRepoPath = path.join(REPOS_DIR, repoName);
            const defaultSkillsRepoPath = path.join(REPOS_DIR, 'AchillesCopilotBasicSkills');

            mkdir(REPOS_DIR);
            initGitRepo(sourceRepoPath, { 'README.md': '# managed\\n' });
            initGitRepo(
                defaultSkillsSourcePath,
                defaultSkillsHasSkills
                    ? { 'skills/defaultSkill/SKILL.md': '# Default skill\\n' }
                    : { 'README.md': '# default skills\\n' },
            );
            mkdir(path.join(REPOS_DIR, providerName, 'agent'));
            writeFile(path.join(REPOS_DIR, providerName, 'agent', 'manifest.json'), JSON.stringify({
                repos: { [repoName]: sourceRepoPath },
            }, null, 2));
            mkdir(installedRepoPath);
            writeFile(path.join(installedRepoPath, 'stale.txt'), 'stale\\n');
            execFileSync('git', ['clone', '--quiet', defaultSkillsSourcePath, defaultSkillsRepoPath], { stdio: 'ignore' });

            return { repoName, installedRepoPath, defaultSkillsRepoPath };
        }

        function assertDefaultSkillsSummary(summary, repoName) {
            assert.ok(summary, 'aggregate result includes defaultSkills');
            assert.equal(summary.defaultSkillsRepoName, 'AchillesCopilotBasicSkills');
            assert.equal(summary.total, 2);
            assert.deepEqual(summary.refreshed.map(entry => entry.repoName), [repoName]);
            assert.deepEqual(
                summary.skipped.map(entry => ({ repoName: entry.repoName, reason: entry.reason })),
                [{ repoName: 'AchillesCopilotBasicSkills', reason: 'default skills source repo' }],
            );
            assert.equal(summary.failed.length, 0);
        }

        installGitWrapper();
        setupRuntimeAchilles();

        const { REPOS_DIR } = await import(${JSON.stringify(configUrl)});
        const { updatePloinkyRepos, updateAllRepos } = await import(${JSON.stringify(commandsUrl)});

        ${body}
    `], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: runtimeRoot,
            PLOINKY_AGENTLIB_REF: '',
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

        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'stale.js'), 'stale file\n');

        copySkill(src, dest);

        // Files from source are copied / overwritten
        assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(dest, 'tool.js')), true);
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
            const defaultSkillsRepoPath = path.join(REPOS_DIR, 'AchillesCopilotBasicSkills');

            mkdir(REPOS_DIR);
            initGitRepo(sourceRepoPath);
            mkdir(path.join(REPOS_DIR, providerName, 'agent'));
            fs.writeFileSync(path.join(REPOS_DIR, providerName, 'agent', 'manifest.json'), JSON.stringify({
                repos: { [repoName]: sourceRepoPath },
            }, null, 2));
            mkdir(installedRepoPath);
            fs.writeFileSync(path.join(installedRepoPath, 'stale.txt'), 'stale\\n');
            mkdir(defaultSkillsRepoPath);

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
            assert.ok(logs.includes('  Default skills summary: 0/1 repo(s) refreshed.'));
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

            const ploinkyResult = await updatePloinkyRepos();

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

test('updatePloinkyRepos surfaces default skill failures in aggregate errors', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-aggregate-default-skills-failure-'));

    try {
        runAggregateUpdateChild(workspaceRoot, `
            const fixture = setupAggregateRepoFixture({ defaultSkillsHasSkills: false });

            await assert.rejects(
                () => updatePloinkyRepos(),
                (err) => {
                    assert.match(
                        err.message,
                        new RegExp('Failed to update 1 repository\\\\(s\\\\): default skills ' + fixture.repoName),
                    );
                    return true;
                },
            );
            assert.equal(fs.existsSync(path.join(fixture.installedRepoPath, 'README.md')), true);
            assert.equal(
                fs.existsSync(path.join(fixture.installedRepoPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
                false,
            );
        `);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

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
