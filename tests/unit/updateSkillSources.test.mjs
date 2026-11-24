import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Update refreshes Git checkouts without reading or exporting skill manifests.
// Existing skill output and private Git exclusions belong to explicit skill operations.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

// Operations the printed update summary does not count as updated.
const summaryShortfall = out => {
    const match = /^Update summary: (\d+)\/(\d+) update operations succeeded/.exec(out.find(line => line.startsWith('Update summary:')) || '');
    return match ? Number(match[2]) - Number(match[1]) : null;
};

const PRELUDE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const scratch = process.env.PLOINKY_TEST_SCRATCH;
const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}
function makeRemote(name, files) {
    const remote = path.join(scratch, 'remotes', name + '.git');
    const seed = path.join(scratch, 'remotes', name + '-seed');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    return { remote, seed };
}
function clone(remote, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('git', ['clone', '-q', remote, destination]);
}
function advance(seed, rel, content) {
    writeFile(path.join(seed, rel), content);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'advance ' + rel);
    git(seed, 'push', '-q');
    return git(seed, 'rev-parse', 'HEAD');
}
const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
const skills = await import(${JSON.stringify(moduleUrl('cli/commands/skills.js'))});
for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
    const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
    clone(source.remote, path.join(REPOS_DIR, name));
}
function trace() {
    const file = process.env.PLOINKY_TEST_GIT_TRACE;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
function resetTrace() {
    fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
}
// Git commands that reach a remote or move a checkout.
function networkOrMutation(checkout) {
    const spellings = [checkout, fs.realpathSync(checkout)];
    return trace().filter(line => spellings.some(spelling => line.startsWith('-C ' + spelling + ' ') || line.includes(' ' + spelling + ' ')))
        .filter(line => / (?:fetch|pull|merge|clone|checkout|reset|ls-remote)(?: |$)/.test(line));
}
async function quiet(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    try { return await operation(); } finally { Object.assign(console, original); }
}
// Same as quiet(), but keeps every printed line so a summary can be asserted.
async function captured(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    const out = [];
    console.log = console.error = console.warn = (...values) => out.push(values.map(String).join(' '));
    try { return { value: await operation(), out }; } finally { Object.assign(console, original); }
}
const brief = result => (result?.records || []).map(record => [record.phase, record.id, record.outcome, record.code]);
const manifestRecords = result => (result?.records || []).filter(record => record.phase === 'skills-manifest');
const decision = result => ({
    status: result.status, exitCode: result.exitCode, activationAllowed: result.activationAllowed,
    blockedBy: result.blockedBy, errors: result.errors,
});
const cloneAttempts = () => trace().filter(line => /(?:^| )clone /.test(line));
function done(value) {
    process.stdout.write('RESULT:' + JSON.stringify(value) + '\n');
}
`;

function runScenario(body) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-skill-sources-'));
    try {
        const workspaceRoot = path.join(scratch, 'workspace');
        const bin = path.join(scratch, 'bin');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'runtime-root'), { recursive: true });
        fs.mkdirSync(bin);
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
        fs.writeFileSync(path.join(bin, 'git'), [
            '#!/bin/sh',
            'printf \'%s\\n\' "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
            'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
            `exec "${realGit}" "$@"`,
            '',
        ].join('\n'));
        fs.chmodSync(path.join(bin, 'git'), 0o755);
        const env = {
            ...process.env,
            HOME: scratch,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: path.join(scratch, 'runtime-root'),
            PLOINKY_TEST_SCRATCH: scratch,
            PLOINKY_TEST_GIT_TRACE: path.join(scratch, 'git-trace.log'),
        };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT',
            'PLOINKY_UPDATE_REPORT_NONCE', 'PLOINKY_UPDATE_REPORT_CONTEXT', 'PLOINKY_SKILL_EXCLUDES_COMPOSE']) delete env[name];
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], {
            cwd: workspaceRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}


for (const mode of ['all', 'repos', 'repo']) {
    test(`update ${mode} preserves skills, manifests and exclusions without contacting manifest-only sources`, () => {
        const result = runScenario(String.raw`
            const source = makeRemote('App', { 'agent/manifest.json': '{}', 'code.txt': 'old\n' });
            const repo = path.join(REPOS_DIR, 'App');
            clone(source.remote, repo);
            advance(source.seed, 'code.txt', 'new\n');
            const manifest = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
            writeFile(manifest, JSON.stringify([{ name: 'MissingSkillSource', url: path.join(scratch, 'missing.git'), skills: ['x'] }]));
            writeFile(path.join(workspaceRoot, 'invalid', 'ploinky-skills-manifest.json'), '{invalid');
            const preserved = [manifest,
                path.join(workspaceRoot, '.agents/skills/mine/SKILL.md'),
                path.join(workspaceRoot, '.claude/skills/mine/SKILL.md'),
                path.join(workspaceRoot, '.git/info/exclude')];
            for (const file of preserved.slice(1)) writeFile(file, 'keep my content\n');
            const before = preserved.map(file => fs.readFileSync(file, 'utf8'));
            resetTrace();
            const run = await captured(() => ${mode === 'all'
                ? 'commands.updateAllRepos(workspaceRoot, { interactiveSession: true })'
                : mode === 'repos' ? 'commands.updatePloinkyRepos({ interactiveSession: true })'
                : "commands.updateRepoResult('App')"});
            done({ records: brief(run.value), out: run.out, before,
                after: preserved.map(file => fs.readFileSync(file, 'utf8')),
                code: fs.readFileSync(path.join(repo, 'code.txt'), 'utf8'),
                root: workspaceRoot, trace: trace(),
                exported: fs.existsSync(path.join(repo, '.agents/skills')),
                cloned: fs.existsSync(path.join(REPOS_DIR, 'MissingSkillSource')) });
        `);
        assert.deepEqual(result.after, result.before);
        assert.equal(result.code, 'new\n');
        assert.equal(result.cloned, false);
        assert.equal(result.exported, false);
        assert.ok(!result.records.some(record => ['skills-manifest', 'default-skills'].includes(record[0])));
        assert.ok(!result.records.some(record => record[0] === 'workspace-repository' && record[1] === result.root));
        assert.doesNotMatch(result.out.join('\n'), /\[skills\]|Installing skills|Default skills summary/);
        assert.ok(!result.trace.some(line => line.includes('missing.git')));
    });
}

test('a retained stale source is not a failed source and an uncertain source record makes the manifest uncertain', () => {
    const result = runScenario(String.raw`
        const { createOperationRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
        const { skillsManifestRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateRecords.js'))});
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n' });
        const cachePath = path.join(REPOS_DIR, 'CacheSkills');
        clone(cache.remote, cachePath);
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1'] }]));
        await quiet(() => skills.installSkillsFromManifest(manifestPath, { targetRoot: workspaceRoot, pruneMissing: true }));
        const sourceRecord = outcome => createOperationRecord({
            phase: 'registered-repository', id: 'CacheSkills', outcome, code: 'fixture-' + outcome, reason: 'fixture',
            details: { checkout: { path: fs.realpathSync(cachePath) } },
        });
        const consume = async outcome => {
            const run = await quiet(() => skills.installSkillsFromManifest(manifestPath, {
                targetRoot: workspaceRoot, pruneMissing: true, sourceOutcomes: [sourceRecord(outcome)],
            }));
            const record = skillsManifestRecord({ folder: workspaceRoot, manifestPath, label: 'workspace', result: run });
            return { states: run.sources.map(source => [source.state, source.sourceOutcome || null, source.code || null]), outcome: record.outcome, code: record.code,
                uncertainSources: record.details.uncertainSources || null, failedSources: record.details.failedSources || null };
        };
        done({
            skipped: await consume('skipped'),
            failed: await consume('failed'),
            uncertain: await consume('uncertain'),
            c1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'c1', 'SKILL.md'), 'utf8'),
        });
    `);
    for (const name of ['skipped', 'failed']) {
        assert.equal(result[name].states[0][0], 'stale', `${name} source record: the checkout is used as it is`);
        assert.equal(result[name].states[0][1], null);
        assert.ok(['changed', 'unchanged'].includes(result[name].outcome), `${name}: ${JSON.stringify(result[name])}`);
        assert.equal(result[name].failedSources, null);
    }
    assert.deepEqual(result.uncertain.states[0].slice(0, 2), ['retained', 'uncertain']);
    assert.equal(result.uncertain.states[0][2], 'fixture-uncertain', 'the source record code is kept');
    assert.equal(result.uncertain.outcome, 'uncertain');
    assert.equal(result.uncertain.code, 'skill-source-uncertain');
    assert.equal(result.uncertain.uncertainSources[0].name, 'CacheSkills');
    assert.equal(result.c1, '# c1\n', 'nothing was pruned');
});


test('workspace discovery skips incomplete Git metadata but finds nested checkouts and Git worktrees', () => {
    const result = runScenario(String.raw`
        const repos = await import(${JSON.stringify(moduleUrl('cli/utils/repos.js'))});
        writeFile(path.join(workspaceRoot, '.git/info/exclude'), 'keep\n');
        const source = makeRemote('Nested', { 'a.txt': 'tracked\n' });
        const nested = path.join(workspaceRoot, 'projects/Nested');
        clone(source.remote, nested);
        const worktree = path.join(workspaceRoot, 'linked-worktree');
        git(nested, 'worktree', 'add', '-q', '-b', 'linked', worktree);
        done(repos.findWorkspaceGitRepos(workspaceRoot).map(entry => path.relative(workspaceRoot, entry.path)).sort());
    `);
    assert.deepEqual(result, ['linked-worktree', 'projects/Nested']);
});
