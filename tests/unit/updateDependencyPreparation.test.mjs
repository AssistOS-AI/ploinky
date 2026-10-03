import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function projectFileUrl(relPath) {
    return pathToFileURL(path.join(projectRoot, relPath)).href;
}

// `ploinky update` changes sources only. Dependency caches are prepared by the
// lifecycle command that (re)admits the affected runtime, so no update form may
// start a container runtime, run npm, or write the dependency cache.
function runUpdateWithRuntimeStub(invocation) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-no-deps-'));
    // The stub lives beside the workspace, never inside a package tree.
    const stubBin = path.join(scratch, 'stub-bin');
    const runtimeLog = path.join(scratch, 'runtime.log');
    const workspaceRoot = path.join(scratch, 'workspace');
    const runtimeRoot = path.join(scratch, 'runtime-root');
    fs.mkdirSync(stubBin, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    for (const name of ['podman', 'docker', 'npm']) {
        const stub = path.join(stubBin, name);
        fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${runtimeLog}"\nexit 125\n`);
        fs.chmodSync(stub, 0o755);
    }
    try {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { execFileSync } from 'node:child_process';

            const workspaceRoot = ${JSON.stringify(workspaceRoot)};
            const { REPOS_DIR, PLOINKY_DIR } = await import(${JSON.stringify(projectFileUrl('cli/utils/config.js'))});
            const commands = await import(${JSON.stringify(projectFileUrl('cli/commands/repoAgentCommands.js'))});

            const git = (cwd, ...args) => String(execFileSync('git', args, {
                cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            })).trim();
            function writeFile(filePath, content) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, content);
            }
            function initRepo(repoPath, files) {
                fs.mkdirSync(repoPath, { recursive: true });
                git(repoPath, 'init', '-q', '-b', 'main');
                git(repoPath, 'config', 'user.email', 'test@example.invalid');
                git(repoPath, 'config', 'user.name', 'Test User');
                for (const [rel, content] of Object.entries(files)) writeFile(path.join(repoPath, rel), content);
                git(repoPath, 'add', '.');
                git(repoPath, 'commit', '-q', '-m', 'initial');
            }
            function commit(repoPath, rel, content) {
                writeFile(path.join(repoPath, rel), content);
                git(repoPath, 'add', rel);
                git(repoPath, 'commit', '-q', '-m', 'advance ' + rel);
                return git(repoPath, 'rev-parse', 'HEAD');
            }

            const sources = path.join(workspaceRoot, '.fixtures');
            const agentSource = path.join(sources, 'agents');
            initRepo(agentSource, {
                'demo/manifest.json': JSON.stringify({ container: 'node:20-alpine', agent: 'node index.js' }),
                'demo/package.json': JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '^1.3.0' } }),
                'demo/index.js': '',
            });
            fs.mkdirSync(REPOS_DIR, { recursive: true });
            git(REPOS_DIR, 'clone', '-q', agentSource, 'UnitDepsRepo');
            for (const [name, skill] of [
                ['AchillesCopilotBasicSkills', 'basic'],
                ['DocumentationSkills', 'docs'],
                ['PloinkySkills', 'ploinky'],
            ]) {
                const source = path.join(sources, name);
                initRepo(source, { ['skills/' + skill + '/SKILL.md']: '# ' + skill + '\\n' });
                git(REPOS_DIR, 'clone', '-q', source, name);
            }
            const installed = path.join(REPOS_DIR, 'UnitDepsRepo');
            const advanced = commit(agentSource, 'demo/package.json',
                JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '^1.3.0', 'is-odd': '^3.0.1' } }));

            const result = await (${invocation});
            assert.deepEqual(result.errors, [], 'update recorded no failure');
            assert.equal(git(installed, 'rev-parse', 'HEAD'), advanced, 'the source update still happened');
            assert.equal(fs.existsSync(path.join(PLOINKY_DIR, 'deps')), false, 'update wrote no dependency cache');
            process.stdout.write('UPDATE_OK\\n');
        `], {
            cwd: workspaceRoot,
            env: {
                ...process.env,
                PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                PLOINKY_ROOT: runtimeRoot,
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const runtimeCalls = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8') : '';
        return { output, runtimeCalls };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

for (const [label, invocation] of [
    ['targeted update repo', "commands.updateRepoResult('UnitDepsRepo')"],
    ['repositories-only update', 'commands.updatePloinkyRepos({ interactiveSession: true })'],
    ['bulk folder update', 'commands.updateAllRepos(workspaceRoot, { interactiveSession: true })'],
]) {
    test(`${label} pulls sources without preparing dependency caches`, () => {
        const { output, runtimeCalls } = runUpdateWithRuntimeStub(invocation);
        assert.match(output, /UPDATE_OK/);
        assert.equal(runtimeCalls, '', 'no container runtime or npm invocation during update');
    });
}
